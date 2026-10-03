// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use super::open_regular_file_read;
use http_range::HttpRange;
use std::io::{Read, Seek};
use std::path::Path;
use std::{borrow::Cow, io::SeekFrom};
use tauri::http::{header::*, status::StatusCode, Request, Response};
use tauri::utils::mime_type::MimeType;
use tauri::{http, path::SafePathBuf};

pub(crate) fn response(
    request: Request<Vec<u8>>,
    window_origin: &str,
    allowed: impl Fn(&Path) -> bool,
) -> Response<Cow<'static, [u8]>> {
    match get_response(request, &allowed, window_origin) {
        Ok(response) => response,
        Err(error) => {
            let mut response = Response::new(Cow::Owned(error.to_string().into_bytes()));
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            response
                .headers_mut()
                .insert(CONTENT_TYPE, "text/plain".parse().unwrap());
            if let Ok(origin) = window_origin.parse() {
                response
                    .headers_mut()
                    .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            }
            response
        }
    }
}

fn get_response(
    request: Request<Vec<u8>>,
    allowed: &impl Fn(&Path) -> bool,
    window_origin: &str,
) -> Result<Response<Cow<'static, [u8]>>, Box<dyn std::error::Error>> {
    let mut resp = Response::builder().header("Access-Control-Allow-Origin", window_origin);
    let Some(encoded_path) = request.uri().path().strip_prefix('/') else {
        return resp.status(403).body(Vec::new().into()).map_err(Into::into);
    };
    let path = percent_encoding::percent_decode(encoded_path.as_bytes())
        .decode_utf8()?
        .to_string();

    if SafePathBuf::new(path.clone().into()).is_err() {
        return resp.status(403).body(Vec::new().into()).map_err(Into::into);
    }

    if !allowed(Path::new(&path)) {
        return resp.status(403).body(Vec::new().into()).map_err(Into::into);
    }

    let mut file = match open_regular_file_read(Path::new(&path)) {
        Ok(Some(file)) => file,
        Ok(None) => return resp.status(404).body(Vec::new().into()).map_err(Into::into),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return resp.status(403).body(Vec::new().into()).map_err(Into::into);
        }
        Err(error) => return Err(error.into()),
    };

    let len = file.metadata()?.len();
    let (mime_type, cached_bytes) = {
        // get file mime type
        let nbytes = len.min(8192);
        let magic_buf = read_bytes(&mut file, nbytes)?;
        file.rewind()?;
        (
            MimeType::parse(&magic_buf, &path),
            // return the `magic_bytes` if we read the whole file
            // to avoid reading it again later if this is not a range request
            if len < 8192 { Some(magic_buf) } else { None },
        )
    };

    resp = resp.header(CONTENT_TYPE, &mime_type);

    // handle 206 (partial range) http requests
    let response = if request.method() == http::Method::HEAD {
        resp.header(CONTENT_LENGTH, len).body(Vec::new().into())
    } else if let Some(range_header) = request
        .headers()
        .get("range")
        .and_then(|r| r.to_str().map(|r| r.to_string()).ok())
    {
        resp = resp.header(ACCEPT_RANGES, "bytes");
        resp = resp.header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");

        let not_satisfiable = || {
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .body(vec![].into())
                .map_err(Into::into)
        };

        // parse range header
        let ranges = if let Ok(ranges) = HttpRange::parse(&range_header, len) {
            ranges
                .iter()
                // map the output to spec range <start-end>, example: 0-499
                .map(|r| (r.start, r.start + r.length - 1))
                .collect::<Vec<_>>()
        } else {
            return not_satisfiable();
        };

        /// The Maximum bytes we send in one range
        const MAX_LEN: u64 = 1000 * 1024;

        // single-part range header
        if ranges.len() == 1 {
            let &(start, mut end) = ranges.first().unwrap();

            // check if a range is not satisfiable
            //
            // this should be already taken care of by the range parsing library
            // but checking here again for extra assurance
            if start >= len || end >= len || end < start {
                return not_satisfiable();
            }

            // adjust end byte for MAX_LEN
            end = start + (end - start).min(len - start).min(MAX_LEN - 1);

            // calculate number of bytes needed to be read
            let nbytes = end + 1 - start;

            let buf = {
                file.seek(SeekFrom::Start(start))?;
                read_bytes(&mut file, nbytes)?
            };

            resp = resp.header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
            resp = resp.header(CONTENT_LENGTH, end + 1 - start);
            resp.status(StatusCode::PARTIAL_CONTENT).body(buf.into())
        } else {
            let ranges = ranges
                .iter()
                .filter_map(|&(start, mut end)| {
                    // filter out unsatisfiable ranges
                    //
                    // this should be already taken care of by the range parsing library
                    // but checking here again for extra assurance
                    if start >= len || end >= len || end < start {
                        None
                    } else {
                        // adjust end byte for MAX_LEN
                        end = start + (end - start).min(len - start).min(MAX_LEN - 1);
                        Some((start, end))
                    }
                })
                .collect::<Vec<_>>();

            let boundary = random_boundary()?;
            let boundary_sep = format!("\r\n--{boundary}\r\n");
            let boundary_closer = format!("\r\n--{boundary}--\r\n");

            if let Some(headers) = resp.headers_mut() {
                headers.remove(CONTENT_TYPE);
            }
            resp = resp.header(
                CONTENT_TYPE,
                format!("multipart/byteranges; boundary={boundary}"),
            );

            let buf = {
                // multi-part range header
                let mut buf = Vec::new();

                for (start, end) in ranges {
                    // a new range is being written, write the range boundary
                    append_bytes(&mut buf, boundary_sep.as_bytes())?;

                    // write the needed headers `Content-Type` and `Content-Range`
                    append_bytes(
                        &mut buf,
                        format!("{CONTENT_TYPE}: {mime_type}\r\n").as_bytes(),
                    )?;
                    append_bytes(
                        &mut buf,
                        format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n").as_bytes(),
                    )?;

                    // write the separator to indicate the start of the range body
                    append_bytes(&mut buf, b"\r\n")?;

                    // calculate number of bytes needed to be read
                    let nbytes = end + 1 - start;

                    file.seek(SeekFrom::Start(start))?;
                    let local_buf = read_bytes(&mut file, nbytes)?;
                    append_bytes(&mut buf, &local_buf)?;
                }
                // all ranges have been written, write the closing boundary
                append_bytes(&mut buf, boundary_closer.as_bytes())?;

                buf
            };
            resp.status(StatusCode::PARTIAL_CONTENT).body(buf.into())
        }
    } else {
        // avoid reading the file if we already read it
        // as part of mime type detection
        let buf = if let Some(b) = cached_bytes {
            b
        } else {
            read_bytes(&mut file, len)?
        };
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(buf.into())
    };

    response.map_err(Into::into)
}

fn random_boundary() -> std::io::Result<String> {
    let mut bytes = [0_u8; 30];
    getrandom::fill(&mut bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn allocate_buffer(length: u64) -> std::io::Result<Vec<u8>> {
    let length = usize::try_from(length)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    Ok(bytes)
}

fn read_bytes(file: &mut impl Read, length: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = allocate_buffer(length)?;
    file.take(length).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != length {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "The image changed while it was being read.",
        ));
    }
    Ok(bytes)
}

fn append_bytes(output: &mut Vec<u8>, bytes: &[u8]) -> std::io::Result<()> {
    output
        .try_reserve(bytes.len())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    output.extend_from_slice(bytes);
    Ok(())
}

pub(crate) fn webview_origin(url: &tauri::Url) -> String {
    if url.scheme() == "data" {
        "null".into()
    } else if cfg!(any(windows, target_os = "android")) && !matches!(url.scheme(), "http" | "https")
    {
        format!("http://{}.localhost", url.scheme())
    } else if let Some(host) = url.host() {
        format!(
            "{}://{}{}",
            url.scheme(),
            host,
            url.port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default()
        )
    } else {
        "null".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request(path: &Path, method: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let encoded = percent_encoding::utf8_percent_encode(
            path.to_str().unwrap(),
            percent_encoding::NON_ALPHANUMERIC,
        );
        let mut request = Request::builder()
            .method(method)
            .uri(format!("asset://localhost/{encoded}?view=1"));
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        request.body(Vec::new()).unwrap()
    }

    #[test]
    fn image_responses_keep_encoded_unicode_paths_mime_cors_and_exact_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("Odd 研究 😀 %.svg");
        let image = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Exact image</text></svg>";
        fs::write(&path, image).unwrap();
        let result = response(
            request(&path, "GET", None),
            "tauri://localhost",
            |candidate| candidate == path,
        );
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(result.headers()[CONTENT_TYPE], "image/svg+xml");
        assert_eq!(
            result.headers()[ACCESS_CONTROL_ALLOW_ORIGIN],
            "tauri://localhost"
        );
        assert_eq!(result.headers()[CONTENT_LENGTH], image.len().to_string());
        assert_eq!(result.body().as_ref(), image);
    }

    #[test]
    fn asset_scope_denial_and_encoded_parent_traversal_fail_before_file_reads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.svg");
        fs::write(&path, b"private image").unwrap();
        assert_eq!(
            response(request(&path, "GET", None), "tauri://localhost", |_| false).status(),
            StatusCode::FORBIDDEN
        );
        let traversal = directory.path().join("../private.svg");
        assert_eq!(
            response(
                request(&traversal, "GET", None),
                "tauri://localhost",
                |_| true
            )
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(fs::read(&path).unwrap(), b"private image");
    }

    #[test]
    fn head_and_single_ranges_keep_length_suffix_open_ended_and_unsatisfied_semantics() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.png");
        let image = b"0123456789abcdef";
        fs::write(&path, image).unwrap();
        let head = response(
            request(&path, "HEAD", None),
            "http://localhost:1420",
            |_| true,
        );
        assert!(head.body().is_empty());
        assert_eq!(head.headers()[CONTENT_LENGTH], "16");
        let ranged_head = response(
            request(&path, "HEAD", Some("bytes=2-5")),
            "tauri://localhost",
            |_| true,
        );
        assert_eq!(ranged_head.status(), StatusCode::OK);
        assert!(ranged_head.body().is_empty());
        assert_eq!(ranged_head.headers()[CONTENT_LENGTH], "16");
        for (range, expected, content_range) in [
            ("bytes=2-5", b"2345".as_slice(), "bytes 2-5/16"),
            ("bytes=-4", b"cdef", "bytes 12-15/16"),
            ("bytes=12-", b"cdef", "bytes 12-15/16"),
        ] {
            let part = response(
                request(&path, "GET", Some(range)),
                "tauri://localhost",
                |_| true,
            );
            assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(part.headers()[CONTENT_RANGE], content_range);
            assert_eq!(part.body().as_ref(), expected);
        }
        for range in ["invalid range", "bytes=100-200"] {
            let result = response(
                request(&path, "GET", Some(range)),
                "tauri://localhost",
                |_| true,
            );
            assert_eq!(result.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(result.headers()[CONTENT_RANGE], "bytes */16");
        }
    }

    #[test]
    fn multipart_ranges_keep_each_image_fragment_and_complete_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.png");
        fs::write(&path, b"0123456789abcdef").unwrap();
        let result = response(
            request(&path, "GET", Some("bytes=0-2,7-9")),
            "tauri://localhost",
            |_| true,
        );
        assert_eq!(result.status(), StatusCode::PARTIAL_CONTENT);
        let content_type = result.headers()[CONTENT_TYPE].to_str().unwrap();
        let boundary = content_type
            .strip_prefix("multipart/byteranges; boundary=")
            .unwrap();
        let body = String::from_utf8_lossy(result.body());
        assert!(body.contains("content-range: bytes 0-2/16\r\n\r\n012"));
        assert!(body.contains("content-range: bytes 7-9/16\r\n\r\n789"));
        assert!(body.ends_with(&format!("\r\n--{boundary}--\r\n")));
    }

    #[test]
    fn full_reads_and_range_limit_support_larger_images_without_whole_file_range_reads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let image = vec![42; 1_100_000];
        fs::write(&path, &image).unwrap();
        let full = response(request(&path, "GET", None), "tauri://localhost", |_| true);
        assert_eq!(full.body().as_ref(), image);
        let range = response(
            request(&path, "GET", Some("bytes=0-")),
            "tauri://localhost",
            |_| true,
        );
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.body().len(), 1_024_000);
        assert_eq!(range.headers()[CONTENT_RANGE], "bytes 0-1023999/1100000");
        assert!(allocate_buffer(u64::MAX).is_err());
    }

    #[test]
    fn missing_images_and_directories_return_errors_without_changing_any_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.svg");
        assert_eq!(
            response(request(&path, "GET", None), "tauri://localhost", |_| true).status(),
            StatusCode::NOT_FOUND
        );
        fs::create_dir(&path).unwrap();
        assert_eq!(
            response(request(&path, "GET", None), "tauri://localhost", |_| true).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn allowed_fifo_images_and_symlink_replacements_fail_without_a_rescue_writer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipe.svg");
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let link = directory.path().join("linked.svg");
        fs::write(&link, b"previous regular image").unwrap();
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&path, &link).unwrap();
        for path in [path, link] {
            let read_path = path.clone();
            let (sender, receiver) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                sender
                    .send(
                        response(
                            request(&read_path, "GET", None),
                            "tauri://localhost",
                            |_| true,
                        )
                        .status(),
                    )
                    .unwrap();
            });
            let result = receiver.recv_timeout(std::time::Duration::from_millis(250));
            if result.is_err() {
                let _ = fs::OpenOptions::new().write(true).open(&path).unwrap();
            }
            reader.join().unwrap();
            assert_eq!(
                result.expect("image reads must fail without a rescue writer"),
                StatusCode::INTERNAL_SERVER_ERROR
            );
        }
    }

    #[test]
    fn webview_origin_keeps_development_and_platform_production_origins() {
        assert_eq!(
            webview_origin(&tauri::Url::parse("http://localhost:1420/app").unwrap()),
            "http://localhost:1420"
        );
        assert_eq!(
            webview_origin(&tauri::Url::parse("tauri://localhost/app").unwrap()),
            if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
        );
        assert_eq!(
            webview_origin(&tauri::Url::parse("data:text/html,Hello").unwrap()),
            "null"
        );
    }

    #[test]
    fn concurrent_image_truncation_is_reported_instead_of_an_incorrect_success_length() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("changing.svg");
        fs::write(&path, b"Previous complete image bytes").unwrap();
        let mut handle = fs::File::open(&path).unwrap();
        let expected_length = handle.metadata().unwrap().len();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(3)
            .unwrap();
        assert_eq!(
            read_bytes(&mut handle, expected_length).unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
        assert_eq!(fs::read(&path).unwrap(), b"Pre");
    }
}
