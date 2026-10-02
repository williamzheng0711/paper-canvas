use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::process::Command;

#[cfg(target_os = "macos")]
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_fs::FsExt;

#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSCopying, NSString, NSURL};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

struct OpenedFiles(Mutex<Vec<String>>);

fn supported_markdown_path(path: PathBuf) -> Option<PathBuf> {
    let extension = path.extension()?.to_string_lossy();
    if !matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") || !path.is_file() {
        return None;
    }
    Some(path.canonicalize().unwrap_or(path))
}

#[cfg(any(target_os = "macos", test))]
fn is_absolute_pdf_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn markdown_paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .filter_map(|arg| {
            let path = PathBuf::from(arg);
            supported_markdown_path(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn markdown_paths_from_urls(urls: Vec<tauri::Url>) -> Vec<PathBuf> {
    urls.into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(supported_markdown_path)
        .collect()
}

fn record_opened_files<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter_map(|path| {
            // Finder/Explorer did not use a Tauri file dialog, so mirror the
            // dialog plugin's least-privilege, per-file scope grant.
            let _ = app.fs_scope().allow_file(&path);
            let _ = app.state::<tauri::scope::Scopes>().allow_file(&path);
            path.to_str().map(str::to_owned)
        })
        .collect();
    if paths.is_empty() {
        return;
    }

    app.state::<OpenedFiles>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .extend(paths.clone());
    let _ = app.emit("opened", paths);
}

#[tauri::command]
fn take_opened_files(app: AppHandle) -> Vec<String> {
    let opened_files = app.state::<OpenedFiles>();
    let mut paths = opened_files
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *paths)
}

fn document_asset_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("The document path must be absolute without parent traversal.".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid document filename.".to_string())?;
    // Match the existing frontend naming, including legacy .markdown.assets folders.
    let stem = if name.to_ascii_lowercase().ends_with(".md") {
        &name[..name.len() - 3]
    } else {
        name
    };
    let directory = path.with_file_name(format!("{stem}.assets"));
    // Do not turn a companion-directory symlink into access to an unrelated folder.
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("The image asset path must be a regular directory.".into());
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    Ok(directory)
}

#[tauri::command]
fn allow_document_assets(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !app.fs_scope().is_allowed(&path) {
        return Err("The document path is outside the granted file scope.".into());
    }
    let directory = document_asset_directory(&path)?;
    app.fs_scope()
        .allow_directory(&directory, false)
        .map_err(|error| error.to_string())?;
    app.state::<tauri::scope::Scopes>()
        .allow_directory(&directory, false)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let target = supported_markdown_path(PathBuf::from(path))
        .ok_or_else(|| "The recent Markdown document no longer exists.".to_string())?;

    #[cfg(target_os = "macos")]
    return Command::new("open")
        .arg("-R")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not show the document in its folder: {error}"));

    #[cfg(target_os = "windows")]
    return Command::new("explorer")
        .arg(format!("/select,{}", target.display()))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not show the document in its folder: {error}"));

    #[cfg(target_os = "linux")]
    return Command::new("xdg-open")
        .arg(target.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not show the document folder: {error}"));

    #[allow(unreachable_code)]
    Err("Showing a document in its folder is unavailable on this platform.".to_string())
}

fn validated_external_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "The link URL is invalid.".to_string())?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "mailto" => Ok(url),
        _ => Err("Only HTTP, HTTPS, and email links can be opened externally.".into()),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = validated_external_url(&url)?;

    #[cfg(target_os = "macos")]
    return Command::new("open")
        .arg(target.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link: {error}"));

    #[cfg(target_os = "windows")]
    return Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(target.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link: {error}"));

    #[cfg(target_os = "linux")]
    return Command::new("xdg-open")
        .arg(target.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link: {error}"));

    #[allow(unreachable_code)]
    Err("Opening external links is unavailable on this platform.".into())
}

#[cfg(target_os = "macos")]
fn temporary_pdf_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "PDF filename is not valid UTF-8.".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(path.with_file_name(format!(
        ".{name}.papercanvas-{}-{nonce}.tmp.pdf",
        std::process::id()
    )))
}

#[cfg(target_os = "macos")]
fn pdf_has_complete_trailer(path: &Path) -> std::io::Result<Option<u64>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let length = file.metadata()?.len();
    if length < 10 {
        return Ok(None);
    }

    let mut signature = [0_u8; 5];
    file.read_exact(&mut signature)?;
    if &signature != b"%PDF-" {
        return Ok(None);
    }

    let tail_length = length.min(4096) as usize;
    file.seek(SeekFrom::End(-(tail_length as i64)))?;
    let mut tail = vec![0_u8; tail_length];
    file.read_exact(&mut tail)?;
    if tail.windows(5).any(|window| window == b"%%EOF") {
        Ok(Some(length))
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn wait_for_complete_pdf(path: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut previous_complete_length = None;
    while Instant::now() < deadline {
        match pdf_has_complete_trailer(path).map_err(|error| error.to_string())? {
            Some(length) if previous_complete_length == Some(length) => return Ok(()),
            Some(length) => previous_complete_length = Some(length),
            None => previous_complete_length = None,
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("PDF export did not finish within 90 seconds.".to_string())
}

#[cfg(target_os = "macos")]
fn begin_webview_pdf_export(
    webview: tauri::webview::PlatformWebview,
    path: &Path,
) -> Result<(), String> {
    let path_string = path
        .to_str()
        .ok_or_else(|| "PDF path is not valid UTF-8.".to_string())?;

    // SAFETY: `with_webview` supplies the native WKWebView on the main thread.
    // AppKit retains the modal operation while its detached printing thread is
    // running; the Rust side waits for a complete PDF trailer off the UI thread.
    unsafe {
        let native_webview: &WKWebView = &*webview.inner().cast();
        let window = native_webview
            .window()
            .ok_or_else(|| "The PaperCanvas window is not available for PDF export.".to_string())?;
        let print_info = NSPrintInfo::sharedPrintInfo().copy();
        print_info.setTopMargin(0.0);
        print_info.setRightMargin(0.0);
        print_info.setBottomMargin(0.0);
        print_info.setLeftMargin(0.0);
        print_info.setHorizontallyCentered(false);
        print_info.setVerticallyCentered(false);
        print_info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        print_info.setJobDisposition(NSPrintSaveJob);

        let destination = NSURL::fileURLWithPath(&NSString::from_str(path_string));
        let destination_object: &AnyObject = destination.as_ref();
        let saving_url_key = ProtocolObject::<dyn NSCopying>::from_ref(NSPrintJobSavingURL);
        print_info
            .dictionary()
            .setObject_forKey(destination_object, saving_url_key);

        let operation = native_webview.printOperationWithPrintInfo(&print_info);
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        operation.setCanSpawnSeparateThread(true);
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window,
            None,
            None,
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn export_pdf(app: AppHandle, webview: tauri::Webview, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_absolute_pdf_path(&target) {
        return Err("PDF export requires an absolute .pdf path.".to_string());
    }
    if !app.fs_scope().is_allowed(&target) {
        return Err("The selected PDF path is outside the granted file scope.".to_string());
    }
    let temporary_target = temporary_pdf_path(&target)?;

    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let export_target = temporary_target.clone();
    webview
        .with_webview(move |native_webview| {
            let result = begin_webview_pdf_export(native_webview, &export_target);
            let _ = sender.blocking_send(result);
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "The native PDF export operation ended unexpectedly.".to_string())??;

    let wait_target = temporary_target.clone();
    let wait_result = tauri::async_runtime::spawn_blocking(move || {
        wait_for_complete_pdf(&wait_target, Duration::from_secs(90))
    })
    .await
    .map_err(|error| error.to_string())?;

    if let Err(error) = wait_result {
        let _ = std::fs::remove_file(&temporary_target);
        return Err(error);
    }

    std::fs::rename(&temporary_target, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temporary_target);
        format!("Could not finish saving the PDF: {error}")
    })?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn export_pdf(_path: String) -> Result<(), String> {
    Err("Direct PDF export is available only on macOS.".to_string())
}

#[cfg(desktop)]
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_args: Vec<String> = std::env::args().skip(1).collect();
    let working_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let initial_files = markdown_paths_from_args(&cli_args, &working_directory);

    let mut builder = tauri::Builder::default().manage(OpenedFiles(Mutex::new(Vec::new())));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = markdown_paths_from_args(&args, Path::new(&cwd));
            record_opened_files(app, paths);
            focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(move |app| {
            record_opened_files(app.handle(), initial_files.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_opened_files,
            allow_document_assets,
            show_in_folder,
            open_external_url,
            export_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building PaperCanvas")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                record_opened_files(app, markdown_paths_from_urls(urls));
                #[cfg(desktop)]
                focus_main_window(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_accept_only_web_and_email_urls() {
        for value in [
            "https://example.com/research?q=one%20two#section",
            "http://example.com/",
            "mailto:reader@example.com",
        ] {
            assert!(validated_external_url(value).is_ok(), "{value}");
        }
        for value in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///private/note.md",
            "ftp://example.com/file",
            "../local.md",
            "--help",
        ] {
            assert!(validated_external_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn companion_assets_use_only_the_documents_sibling_directory() {
        let root = std::env::temp_dir();
        for (name, assets) in [
            ("research.md", "research.assets"),
            ("研究.MD", "研究.assets"),
            ("research.markdown", "research.markdown.assets"),
        ] {
            assert_eq!(
                document_asset_directory(&root.join(name)).unwrap(),
                root.join(assets)
            );
        }
        assert!(document_asset_directory(Path::new("relative.md")).is_err());
        assert!(document_asset_directory(&root.join("../outside.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn companion_assets_reject_symlinked_directories() {
        let root = std::env::temp_dir().join(format!("papercanvas-assets-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let directory = root.join("research.assets");
        std::os::unix::fs::symlink(std::env::temp_dir(), &directory).unwrap();
        let result = document_asset_directory(&root.join("research.md"));
        std::fs::remove_file(directory).unwrap();
        std::fs::remove_dir(root).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn command_line_opening_accepts_only_existing_markdown_files() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a workspace parent")
            .to_path_buf();
        let markdown = workspace.join("README.md");
        let paths = markdown_paths_from_args(
            &[
                markdown.display().to_string(),
                workspace.join("package.json").display().to_string(),
                "does-not-exist.md".to_string(),
            ],
            &workspace,
        );

        assert_eq!(paths, vec![markdown.canonicalize().expect("README exists")]);
    }

    #[test]
    fn file_url_opening_accepts_existing_markdown_files() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a workspace parent")
            .to_path_buf();
        let markdown = workspace
            .join("README.md")
            .canonicalize()
            .expect("README exists");
        let url = tauri::Url::from_file_path(&markdown).expect("absolute file URL");

        assert_eq!(markdown_paths_from_urls(vec![url]), vec![markdown]);
    }

    #[test]
    fn pdf_printing_capability_is_enabled() {
        let capabilities = include_str!("../capabilities/default.json");

        assert!(
            capabilities.contains("\"core:webview:allow-print\""),
            "macOS window.print requires the Tauri webview print capability"
        );
    }

    #[test]
    fn html_image_drag_and_drop_is_enabled() {
        let config = include_str!("../tauri.conf.json");

        assert!(
            config.contains("\"dragDropEnabled\": false"),
            "Tauri's native file-drop interceptor must stay disabled so the editor receives HTML5 DataTransfer files"
        );
    }

    #[test]
    fn direct_pdf_export_accepts_only_absolute_pdf_paths() {
        let valid = PathBuf::from("/tmp/papercanvas-export.pdf");
        let uppercase_extension = PathBuf::from("/tmp/papercanvas-export.PDF");
        let wrong_extension = PathBuf::from("/tmp/papercanvas-export.txt");
        let relative = PathBuf::from("papercanvas-export.pdf");

        assert!(is_absolute_pdf_path(&valid));
        assert!(is_absolute_pdf_path(&uppercase_extension));
        assert!(!is_absolute_pdf_path(&wrong_extension));
        assert!(!is_absolute_pdf_path(&relative));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn direct_pdf_export_waits_for_a_complete_pdf_trailer() {
        let path = std::env::temp_dir().join(format!(
            "papercanvas-pdf-validation-{}-{}.pdf",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock follows Unix epoch")
                .as_nanos()
        ));

        std::fs::write(&path, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")
            .expect("write incomplete PDF fixture");
        assert_eq!(pdf_has_complete_trailer(&path).unwrap(), None);

        let complete = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n";
        std::fs::write(&path, complete).expect("write complete PDF fixture");
        assert_eq!(
            pdf_has_complete_trailer(&path).unwrap(),
            Some(complete.len() as u64)
        );
        wait_for_complete_pdf(&path, Duration::from_secs(1)).expect("complete PDF is accepted");

        std::fs::remove_file(path).expect("remove PDF fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn direct_pdf_export_uses_a_hidden_sibling_temporary_file() {
        let target = PathBuf::from("/tmp/papercanvas-export.pdf");
        let temporary = temporary_pdf_path(&target).expect("temporary path");

        assert_eq!(temporary.parent(), target.parent());
        assert_ne!(temporary, target);
        assert!(temporary
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(
                |name| name.starts_with(".papercanvas-export.pdf.papercanvas-")
                    && name.ends_with(".tmp.pdf")
            ));
    }
}
