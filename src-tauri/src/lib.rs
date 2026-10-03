use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::process::Command;

#[cfg(target_os = "macos")]
use std::{
    io::{Seek, SeekFrom},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_fs::FsExt;
use tauri_plugin_store::StoreExt;

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

fn validate_markdown_save_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
            })
    {
        return Err("Saving requires an absolute Markdown path without parent traversal.".into());
    }
    Ok(())
}

fn resolved_markdown_path(path: &Path, allow_missing: bool) -> Result<PathBuf, String> {
    validate_markdown_save_path(path)?;
    let resolved = match path.canonicalize() {
        Ok(resolved) => {
            if !std::fs::metadata(&resolved)
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("The Markdown document must be a regular file.".into());
            }
            resolved
        }
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            // A dangling symlink must not silently become a different document.
            if std::fs::symlink_metadata(path).is_ok() {
                return Err("The Markdown document link target no longer exists.".into());
            }
            path.parent()
                .ok_or("The document directory is invalid.")?
                .canonicalize()
                .map_err(|error| error.to_string())?
                .join(
                    path.file_name()
                        .ok_or("The document filename is invalid.")?,
                )
        }
        Err(error) => return Err(error.to_string()),
    };
    validate_markdown_save_path(&resolved)?;
    Ok(resolved)
}

fn frontend_document_path(path: &str) -> String {
    // Windows canonicalization uses verbatim prefixes. The frontend resolves
    // Markdown URLs using ordinary drive/UNC roots, so display that spelling
    // while retaining the same physical file and its exact scope grant.
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(drive) = path.strip_prefix(r"\\?\") {
        let bytes = drive.as_bytes();
        if bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':')
            && bytes.get(2) == Some(&b'\\')
        {
            return drive.to_owned();
        }
    }
    path.to_owned()
}

#[tauri::command]
async fn resolve_markdown_document_path(
    app: AppHandle,
    path: String,
    allow_missing: bool,
) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !app.fs_scope().is_allowed(&path) {
        return Err("The document path is outside the granted file scope.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = resolved_markdown_path(&path, allow_missing)?;
        // Mirror the dialog's selected file grant at its physical path only.
        app.fs_scope()
            .allow_file(&resolved)
            .map_err(|error| error.to_string())?;
        app.state::<tauri::scope::Scopes>()
            .allow_file(&resolved)
            .map_err(|error| error.to_string())?;
        resolved
            .to_str()
            .map(frontend_document_path)
            .ok_or_else(|| "The document path is not valid UTF-8.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_markdown_file(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    validate_markdown_save_path(&path)?;
    if !app.fs_scope().is_allowed(&path) {
        return Err("The document path is outside the granted file scope.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let contents = read_regular_file(&path)
            .map_err(|error| error.to_string())?
            .ok_or("The Markdown document no longer exists.")?;
        Ok(tauri::ipc::Response::new(contents))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn check_regular_file_write_access(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Do not wait for a reader if the checked file was replaced by a pipe.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let metadata = options.open(path)?.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The document destination must be a regular file.",
        ));
    }
    if metadata.permissions().readonly() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The destination is read-only.",
        ));
    }
    Ok(())
}

fn replace_file_atomically(
    path: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<(), String> {
    replace_file_atomically_checked(path, None, write)
}

fn replace_file_atomically_checked(
    path: &Path,
    expected_contents: Option<&[u8]>,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<(), String> {
    // Follow an existing document symlink, as ordinary file writes do, rather
    // than replacing the link itself with a different document.
    let target = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            path.canonicalize().map_err(|error| error.to_string())?
        }
        Ok(_) => path.to_path_buf(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => path.to_path_buf(),
        Err(error) => return Err(error.to_string()),
    };
    let expected_target = if expected_contents.is_some() {
        Some(target.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "DOCUMENT_CHANGED_ON_DISK".into()
            } else {
                error.to_string()
            }
        })?)
    } else {
        None
    };
    match std::fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => {
            // Check write access without truncating the destination. Atomic
            // replacement must not bypass an existing read-only document.
            if metadata.permissions().readonly() {
                return Err("The destination is read-only.".into());
            }
            check_regular_file_write_access(&target).map_err(|error| error.to_string())?;
        }
        Ok(_) => return Err("The document destination must be a regular file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let parent = target
        .parent()
        .ok_or_else(|| "The document directory is invalid.".to_string())?;
    // A short, unique sibling name also works for long document filenames.
    // NamedTempFile removes incomplete writes and failed replacements on drop.
    let mut temporary = tempfile::Builder::new()
        .prefix(".papercanvas-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    write(temporary.as_file_mut()).map_err(|error| error.to_string())?;
    // Permissions can change while a large temporary save is being written.
    // Recheck access and preserve the current permissions before replacement.
    match std::fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => {
            if metadata.permissions().readonly() {
                return Err("The destination is read-only.".into());
            }
            check_regular_file_write_access(&target).map_err(|error| error.to_string())?;
            temporary
                .as_file()
                .set_permissions(metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
        Ok(_) => return Err("The document destination must be a regular file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if let Some(expected) = expected_contents {
        if path.canonicalize().ok().as_ref() != expected_target.as_ref() {
            return Err("DOCUMENT_CHANGED_ON_DISK".into());
        }
        let actual = match read_regular_file(&target) {
            Ok(Some(contents)) => contents,
            Ok(None) => {
                return Err("DOCUMENT_CHANGED_ON_DISK".into());
            }
            Err(error) => return Err(error.to_string()),
        };
        if actual != expected {
            return Err("DOCUMENT_CHANGED_ON_DISK".into());
        }
    }
    temporary
        .persist(&target)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn write_markdown_file(
    app: AppHandle,
    path: String,
    contents: String,
    expected_contents: Option<String>,
) -> Result<(), String> {
    let target = PathBuf::from(path);
    validate_markdown_save_path(&target)?;
    if !app.fs_scope().is_allowed(&target) {
        return Err("The document path is outside the granted file scope.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        replace_file_atomically_checked(
            &target,
            expected_contents.as_deref().map(str::as_bytes),
            |file| file.write_all(contents.as_bytes()),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn recovery_draft_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("recovery-draft.json"))
        .map_err(|error| error.to_string())
}

fn read_regular_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "The data path must be a regular file.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A pipe substituted after metadata inspection must not block startup.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    read_regular_file_contents(file).map(Some)
}

fn read_regular_file_contents(mut file: File) -> std::io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The data path must be a regular file.",
        ));
    }
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    Ok(contents)
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("papercanvas.settings.v1"))
        .map_err(|error| error.to_string())
}

fn validate_settings_contents(contents: &[u8]) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_slice(contents).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("The settings file must contain a JSON object.".into());
    }
    Ok(())
}

fn validate_settings_file_at(path: &Path) -> Result<(), String> {
    let Some(contents) = read_regular_file(path).map_err(|error| error.to_string())? else {
        return Ok(());
    };
    validate_settings_contents(&contents)
}

#[tauri::command]
async fn validate_settings_file(app: AppHandle) -> Result<(), String> {
    let path = settings_file_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || validate_settings_file_at(&path))
        .await
        .map_err(|error| error.to_string())?
}

fn write_settings_file_at(path: &Path, contents: &[u8]) -> Result<(), String> {
    validate_settings_contents(contents)?;
    let original = read_regular_file(path).map_err(|error| error.to_string())?;
    if let Some(original) = original.as_deref() {
        validate_settings_contents(original)?;
    }
    let directory = path.parent().ok_or("The settings directory is invalid.")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    replace_file_atomically_checked(path, original.as_deref(), |file| file.write_all(contents))
}

#[tauri::command]
async fn write_settings_store(app: AppHandle) -> Result<(), String> {
    let path = settings_file_path(&app)?;
    let store = app
        .get_store("papercanvas.settings.v1")
        .ok_or("The settings store is not loaded.")?;
    let value: serde_json::Map<String, serde_json::Value> = store.entries().into_iter().collect();
    let contents = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || write_settings_file_at(&path, &contents))
        .await
        .map_err(|error| error.to_string())?
}

fn read_recovery_draft_file(path: &Path) -> Result<Option<String>, String> {
    read_regular_file(path)
        .map_err(|error| error.to_string())?
        .map(|contents| String::from_utf8(contents).map_err(|error| error.to_string()))
        .transpose()
}

fn write_recovery_draft_file(path: &Path, contents: &str) -> Result<(), String> {
    let directory = path.parent().ok_or("The recovery directory is invalid.")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    replace_file_atomically(path, |file| file.write_all(contents.as_bytes()))
}

#[tauri::command]
async fn read_recovery_draft(app: AppHandle) -> Result<Option<String>, String> {
    let path = recovery_draft_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_recovery_draft_file(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_recovery_draft(app: AppHandle, contents: String) -> Result<(), String> {
    let path = recovery_draft_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_recovery_draft_file(&path, &contents))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_recovery_draft(app: AppHandle) -> Result<(), String> {
    let path = recovery_draft_path(&app)?;
    // A durable tombstone also suppresses an older legacy settings-store draft
    // if its supplementary cleanup is interrupted or fails.
    tauri::async_runtime::spawn_blocking(move || write_recovery_draft_file(&path, "null"))
        .await
        .map_err(|error| error.to_string())?
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

fn document_image_files(
    path: &Path,
    images: Vec<PathBuf>,
    document_allowed: bool,
) -> Result<Vec<PathBuf>, String> {
    validate_markdown_save_path(path)?;
    if !document_allowed {
        return Err("The document path is outside the granted file scope.".into());
    }
    Ok(images
        .into_iter()
        .filter(|image| {
            image.is_absolute()
                && image.is_file()
                && image
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        matches!(
                            extension.to_ascii_lowercase().as_str(),
                            "png"
                                | "apng"
                                | "jpg"
                                | "jpeg"
                                | "gif"
                                | "webp"
                                | "svg"
                                | "avif"
                                | "bmp"
                                | "tif"
                                | "tiff"
                                | "ico"
                                | "heic"
                                | "heif"
                        )
                    })
        })
        .collect())
}

#[tauri::command]
async fn allow_document_image_files(
    app: AppHandle,
    path: String,
    images: Vec<String>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let document_allowed = app.fs_scope().is_allowed(&path);
    tauri::async_runtime::spawn_blocking(move || {
        for image in document_image_files(
            &path,
            images.into_iter().map(PathBuf::from).collect(),
            document_allowed,
        )? {
            app.asset_protocol_scope()
                .allow_file(image)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn document_rename_asset_directories(
    source: &Path,
    target: &Path,
    source_allowed: bool,
) -> Result<[PathBuf; 2], String> {
    if !source_allowed {
        return Err("The document path is outside the granted file scope.".into());
    }
    for path in [source, target] {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("md")
                        || extension.eq_ignore_ascii_case("markdown")
                })
        {
            return Err("Rename requires absolute Markdown paths without parent traversal.".into());
        }
    }
    if source.parent() != target.parent() {
        return Err("A document can only be renamed within its current directory.".into());
    }
    match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("The renamed document path must not be a symlink.".into());
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    Ok([
        document_asset_directory(source)?,
        document_asset_directory(target)?,
    ])
}

fn validate_rename_entries(source: &Path, target: &Path) -> Result<(), String> {
    for path in [source, target] {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("Rename requires absolute paths without parent traversal.".into());
        }
    }
    if source.parent() != target.parent() {
        return Err(
            "A document or asset folder can only be renamed within its current directory.".into(),
        );
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_without_replacement(source: &Path, target: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        target,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}

#[cfg(windows)]
fn rename_without_replacement(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if source[..source.len() - 1].contains(&0) || target[..target.len() - 1].contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "A filename cannot contain NUL.",
        ));
    }
    // SAFETY: Both paths are NUL-terminated UTF-16 buffers. Omitting
    // MOVEFILE_REPLACE_EXISTING makes target creation races fail safely.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_without_replacement(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Safe rename is unavailable on this platform.",
    ))
}

#[tauri::command]
async fn rename_document_entry(
    app: AppHandle,
    source: String,
    target: String,
) -> Result<(), String> {
    let source = PathBuf::from(source);
    let target = PathBuf::from(target);
    validate_rename_entries(&source, &target)?;
    let scope = app.fs_scope();
    if !scope.is_allowed(&source) || !scope.is_allowed(&target) {
        return Err("The rename path is outside the granted file scope.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        rename_without_replacement(&source, &target).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn allow_document_rename(app: AppHandle, source: String, target: String) -> Result<(), String> {
    let source = PathBuf::from(source);
    let target = PathBuf::from(target);
    let fs_scope = app.fs_scope();
    let directories =
        document_rename_asset_directories(&source, &target, fs_scope.is_allowed(&source))?;
    fs_scope
        .allow_file(&target)
        .map_err(|error| error.to_string())?;
    // Rename and exists need access only to these directory entries, not their
    // children or the document's parent directory.
    for directory in &directories {
        fs_scope
            .allow_file(directory)
            .map_err(|error| error.to_string())?;
    }
    let scopes = app.state::<tauri::scope::Scopes>();
    scopes
        .allow_file(&target)
        .map_err(|error| error.to_string())?;
    // Keep local images readable after their derived companion folder moves.
    for directory in &directories {
        scopes
            .allow_directory(directory, false)
            .map_err(|error| error.to_string())?;
    }
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
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "PDF filename is not valid UTF-8.".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    // Keep the temporary sibling short even for a valid near-limit filename.
    Ok(path.with_file_name(format!(
        ".papercanvas-{}-{nonce}.tmp.pdf",
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
    let whitespace = |byte: &u8| matches!(byte, b'\0' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ');
    let end = tail
        .iter()
        .rposition(|byte| !whitespace(byte))
        .map_or(0, |index| index + 1);
    let Some(eof_start) = end.checked_sub(5) else {
        return Ok(None);
    };
    let line_start = tail[..eof_start]
        .iter()
        .rposition(|byte| matches!(byte, b'\r' | b'\n'))
        .map_or(0, |index| index + 1);
    // An EOF token inside a still-growing object or stream is not a trailer.
    if &tail[eof_start..end] == b"%%EOF" && tail[line_start..eof_start].iter().all(whitespace) {
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
        // WebKit calculates its initial page aspect ratio before activating
        // print CSS. Match @page here so later CSS margins keep that ratio.
        print_info.setTopMargin(18.0 * 72.0 / 25.4);
        print_info.setRightMargin(20.0 * 72.0 / 25.4);
        print_info.setBottomMargin(20.0 * 72.0 / 25.4);
        print_info.setLeftMargin(20.0 * 72.0 / 25.4);
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

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| {
                let menu = tauri::menu::Menu::default(app)?;
                // macOS's predefined Quit invokes NSApplication directly,
                // bypassing both ExitRequested and the window close handler.
                // Replace only that last item in the default application menu.
                let application_menu = menu
                    .items()?
                    .into_iter()
                    .next()
                    .and_then(|item| item.as_submenu().cloned())
                    .ok_or_else(|| std::io::Error::other("The application menu is missing."))?;
                let quit = application_menu
                    .items()?
                    .pop()
                    .ok_or_else(|| std::io::Error::other("The Quit menu item is missing."))?;
                let label = quit
                    .as_predefined_menuitem()
                    .ok_or_else(|| std::io::Error::other("The default Quit menu item changed."))?
                    .text()?;
                application_menu.remove(&quit)?;
                application_menu.append(&tauri::menu::MenuItem::with_id(
                    app,
                    "save-before-quit",
                    label,
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
                Ok(menu)
            })
            .on_menu_event(|app, event| {
                if event.id() == "save-before-quit" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    } else {
                        app.exit(0);
                    }
                }
            });
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
            resolve_markdown_document_path,
            read_markdown_file,
            write_markdown_file,
            read_recovery_draft,
            write_recovery_draft,
            clear_recovery_draft,
            validate_settings_file,
            write_settings_store,
            allow_document_assets,
            allow_document_image_files,
            allow_document_rename,
            rename_document_entry,
            show_in_folder,
            open_external_url,
            export_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building PaperCanvas")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Native Quit otherwise bypasses the frontend's close handler
                // and can discard edits still waiting for autosave. Closing the
                // window first lets that handler save before destroying it.
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    let _ = window.close();
                } else if let Some(store) = app.get_store("papercanvas.settings.v1") {
                    // The frontend completed its atomic flush before destroying
                    // the window. Avoid the plugin's unconditional truncating
                    // save when the subsequent Exit event is dispatched.
                    store.close_resource();
                }
            }
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            tauri::RunEvent::Opened { urls } => {
                record_opened_files(app, markdown_paths_from_urls(urls));
                #[cfg(desktop)]
                focus_main_window(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_windows_document_spelling_keeps_drive_and_unc_image_roots() {
        for (canonical, frontend) in [
            (r"\\?\C:\Users\研究\draft.md", r"C:\Users\研究\draft.md"),
            (r"\\?\UNC\server\share\draft.md", r"\\server\share\draft.md"),
            (r"\\server\share\draft.md", r"\\server\share\draft.md"),
            (r"C:\Users\draft.md", r"C:\Users\draft.md"),
            (r"/tmp/\\?\C:\literal.md", r"/tmp/\\?\C:\literal.md"),
            (r"\\?\Volume{123}\draft.md", r"\\?\Volume{123}\draft.md"),
        ] {
            assert_eq!(frontend_document_path(canonical), frontend);
        }
    }

    #[cfg(unix)]
    #[test]
    fn markdown_paths_resolve_document_and_parent_symlinks_before_asset_placement() {
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let links = directory.path().join("links");
        std::fs::create_dir(&real).unwrap();
        std::fs::create_dir(&links).unwrap();
        let target = real.join("original.md");
        std::fs::write(&target, b"\xef\xbb\xbf# Physical writing\r\n").unwrap();
        let alias = links.join("alias.md");
        std::os::unix::fs::symlink("../real/original.md", &alias).unwrap();
        let physical = target.canonicalize().unwrap();
        assert_eq!(resolved_markdown_path(&alias, false).unwrap(), physical);
        assert_eq!(resolved_markdown_path(&alias, true).unwrap(), physical);
        assert_eq!(
            read_regular_file(&physical).unwrap().unwrap(),
            b"\xef\xbb\xbf# Physical writing\r\n"
        );
        let parent_alias = links.join("directory");
        std::os::unix::fs::symlink(&real, &parent_alias).unwrap();
        assert_eq!(
            resolved_markdown_path(&parent_alias.join("new.md"), true).unwrap(),
            real.canonicalize().unwrap().join("new.md")
        );
        assert!(resolved_markdown_path(&parent_alias.join("new.md"), false).is_err());
        assert!(std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn markdown_paths_reject_dangling_looping_and_non_markdown_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let alias = directory.path().join("alias.md");
        std::os::unix::fs::symlink("missing.md", &alias).unwrap();
        assert!(resolved_markdown_path(&alias, true).is_err());
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink("alias.md", &alias).unwrap();
        assert!(resolved_markdown_path(&alias, true).is_err());
        std::fs::remove_file(&alias).unwrap();
        let other = directory.path().join("image.svg");
        std::fs::write(&other, b"original image").unwrap();
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        assert!(resolved_markdown_path(&alias, true).is_err());
        assert_eq!(std::fs::read(&other).unwrap(), b"original image");
    }

    #[test]
    fn markdown_reads_preserve_exact_bytes_and_reject_directories() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("document.md");
        let bytes = b"\xef\xbb\xbf# UTF-8 \xf0\x9f\xa7\xaa\r\ninvalid:\xff\0";
        std::fs::write(&target, bytes).unwrap();
        assert_eq!(read_regular_file(&target).unwrap().unwrap(), bytes);
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(resolved_markdown_path(&target, false).is_err());
        assert_eq!(
            read_regular_file(&target).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[cfg(unix)]
    #[test]
    fn markdown_fifo_opens_are_rejected_without_waiting_for_a_writer() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("document.md");
        assert!(std::process::Command::new("mkfifo")
            .arg(&target)
            .status()
            .unwrap()
            .success());
        assert!(resolved_markdown_path(&target, false).is_err());
        assert!(resolved_markdown_path(&target, true).is_err());
        assert_eq!(
            read_regular_file(&target).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn markdown_saves_validate_absolute_supported_paths() {
        let root = std::env::temp_dir();
        for name in ["research.md", "研究.MD", "draft.markdown", "draft.MARKDOWN"] {
            assert!(validate_markdown_save_path(&root.join(name)).is_ok());
        }
        for path in [
            PathBuf::from("relative.md"),
            root.join("../outside.md"),
            root.join("image.png"),
        ] {
            assert!(validate_markdown_save_path(&path).is_err());
        }
    }

    #[test]
    fn native_rename_rejects_traversal_and_other_directories() {
        let root = std::env::temp_dir();
        let source = root.join("old.md");
        assert!(validate_rename_entries(&source, &root.join("new.md")).is_ok());
        assert!(
            validate_rename_entries(&root.join("old.assets"), &root.join("new.assets")).is_ok()
        );
        for target in [
            PathBuf::from("relative.md"),
            root.join("../new.md"),
            root.join("other/new.md"),
        ] {
            assert!(validate_rename_entries(&source, &target).is_err());
        }
    }

    #[test]
    fn native_rename_never_replaces_a_file_or_an_empty_asset_directory() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("old.md");
        let target = directory.path().join("new.md");
        std::fs::write(&source, "Original document").unwrap();
        std::fs::write(&target, "Other document created during rename").unwrap();
        assert!(rename_without_replacement(&source, &target).is_err());
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "Original document"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "Other document created during rename"
        );
        let source = directory.path().join("old.assets");
        let target = directory.path().join("new.assets");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("image.png"), b"retained asset").unwrap();
        assert!(rename_without_replacement(&source, &target).is_err());
        assert_eq!(
            std::fs::read(source.join("image.png")).unwrap(),
            b"retained asset"
        );
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }

    #[test]
    fn racing_document_renames_have_one_winner_and_preserve_every_other_source() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.md");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let sources: Vec<_> = (0..12)
            .map(|index| {
                let source = directory.path().join(format!("source-{index}.md"));
                std::fs::write(&source, format!("Document {index}")).unwrap();
                source
            })
            .collect();
        let renames: Vec<_> = sources
            .iter()
            .map(|source| {
                let source = source.clone();
                let target = target.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    rename_without_replacement(&source, &target).is_ok()
                })
            })
            .collect();
        assert_eq!(
            renames
                .into_iter()
                .map(|rename| rename.join().unwrap())
                .filter(|success| *success)
                .count(),
            1
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 12);
        for (index, source) in sources.iter().enumerate() {
            if source.exists() {
                assert_eq!(
                    std::fs::read_to_string(source).unwrap(),
                    format!("Document {index}")
                );
            }
        }
        assert!((0..12)
            .any(|index| std::fs::read_to_string(&target).unwrap() == format!("Document {index}")));
    }

    #[test]
    fn native_case_only_renames_preserve_document_and_asset_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("research.md");
        let target = directory.path().join("Research.MD");
        let source_assets = directory.path().join("research.assets");
        let target_assets = directory.path().join("Research.assets");
        std::fs::write(&source, "# 中文 🧪\r\nOriginal bytes\r\n").unwrap();
        std::fs::create_dir(&source_assets).unwrap();
        std::fs::write(source_assets.join("diagram.png"), b"original asset").unwrap();
        rename_without_replacement(&source, &target).unwrap();
        rename_without_replacement(&source_assets, &target_assets).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "# 中文 🧪\r\nOriginal bytes\r\n"
        );
        assert_eq!(
            std::fs::read(target_assets.join("diagram.png")).unwrap(),
            b"original asset"
        );
        let mut names: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                std::ffi::OsString::from("Research.MD"),
                std::ffi::OsString::from("Research.assets")
            ]
        );
    }

    #[test]
    fn interrupted_markdown_write_preserves_existing_bytes_and_cleans_up() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        let original = "# 原稿\r\n\r\nContent 🧪\r\n";
        std::fs::write(&target, original).unwrap();
        let result = replace_file_atomically(&target, |file| {
            file.write_all(b"partial replacement")?;
            Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "simulated interrupted write",
            ))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), original);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn checked_markdown_saves_use_exact_last_committed_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        let mut previous = "\u{feff}# 原稿\r\n";
        std::fs::write(&target, previous).unwrap();
        for contents in [previous, "", "# Latest 中文 🧪\r\n", "Next revision\n"] {
            replace_file_atomically_checked(&target, Some(previous.as_bytes()), |file| {
                file.write_all(contents.as_bytes())
            })
            .unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), contents.as_bytes());
            previous = contents;
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn checked_markdown_saves_preserve_external_changes_including_non_utf8_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        let original = "Opened source\r\n";
        for external in [
            b"External editor writing\n".as_slice(),
            &[0xff, 0xfe, 0x41, 0x00],
        ] {
            std::fs::write(&target, original).unwrap();
            let result =
                replace_file_atomically_checked(&target, Some(original.as_bytes()), |file| {
                    file.write_all(b"Our later edit")?;
                    // Model an external modification while the temporary save is prepared.
                    std::fs::write(&target, external)
                });
            assert_eq!(result.unwrap_err(), "DOCUMENT_CHANGED_ON_DISK");
            assert_eq!(std::fs::read(&target).unwrap(), external);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn checked_markdown_saves_never_recreate_a_deleted_baseline_destination() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        let original = "Opened source\n";
        for deleted_before_save in [false, true] {
            std::fs::write(&target, original).unwrap();
            if deleted_before_save {
                std::fs::remove_file(&target).unwrap();
            }
            let result =
                replace_file_atomically_checked(&target, Some(original.as_bytes()), |file| {
                    file.write_all(b"Our later edit")?;
                    if !deleted_before_save {
                        std::fs::remove_file(&target)?;
                    }
                    Ok(())
                });
            assert_eq!(result.unwrap_err(), "DOCUMENT_CHANGED_ON_DISK");
            assert!(!target.exists());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn checked_markdown_saves_reject_document_symlink_retargeting_during_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let original_target = directory.path().join("original.md");
        let other_target = directory.path().join("other.md");
        let link = directory.path().join("document.md");
        std::fs::write(&original_target, "Opened source").unwrap();
        std::fs::write(&other_target, "Other writing").unwrap();
        std::os::unix::fs::symlink(&original_target, &link).unwrap();
        let result = replace_file_atomically_checked(&link, Some(b"Opened source"), |file| {
            file.write_all(b"Our later edit")?;
            std::fs::remove_file(&link)?;
            std::os::unix::fs::symlink(&other_target, &link)
        });
        assert_eq!(result.unwrap_err(), "DOCUMENT_CHANGED_ON_DISK");
        assert_eq!(
            std::fs::read_to_string(&original_target).unwrap(),
            "Opened source"
        );
        assert_eq!(
            std::fs::read_to_string(&other_target).unwrap(),
            "Other writing"
        );
        assert_eq!(
            link.canonicalize().unwrap(),
            other_target.canonicalize().unwrap()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn referenced_images_authorize_only_existing_supported_files_for_a_granted_document() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("notes.md");
        let image = directory.path().join("My figure.SVG");
        let missing = directory.path().join("missing.png");
        let credentials = directory.path().join("credentials.txt");
        let folder = directory.path().join("folder.png");
        std::fs::write(&image, "<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
        std::fs::write(&credentials, "private text").unwrap();
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            document_image_files(
                &document,
                vec![
                    image.clone(),
                    missing,
                    credentials,
                    folder,
                    PathBuf::from("relative.png")
                ],
                true
            )
            .unwrap(),
            vec![image.clone()]
        );
        assert!(document_image_files(&document, vec![image], false).is_err());
        assert!(document_image_files(Path::new("relative.md"), vec![], true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn referenced_images_support_existing_image_symlinks_without_granting_a_directory() {
        let directory = tempfile::tempdir().unwrap();
        let image = directory.path().join("image.svg");
        let link = directory.path().join("alias.svg");
        std::fs::write(&image, "<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
        std::os::unix::fs::symlink(&image, &link).unwrap();
        assert_eq!(
            document_image_files(&directory.path().join("notes.md"), vec![link.clone()], true)
                .unwrap(),
            vec![link]
        );
    }

    #[test]
    fn recovery_drafts_commit_exact_json_and_clear_with_a_durable_tombstone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new-app-data/recovery-draft.json");
        assert_eq!(read_recovery_draft_file(&path).unwrap(), None);
        let contents = r#"{"name":"中文 🧪.md","sourceMarkdown":"\ud800\r\nLatest writing"}"#;
        write_recovery_draft_file(&path, contents).unwrap();
        assert_eq!(
            read_recovery_draft_file(&path).unwrap().as_deref(),
            Some(contents)
        );
        let result = replace_file_atomically(&path, |file| {
            file.write_all(b"{partial")?;
            Err(std::io::Error::other(
                "simulated interrupted recovery write",
            ))
        });
        assert!(result.is_err());
        assert_eq!(
            read_recovery_draft_file(&path).unwrap().as_deref(),
            Some(contents)
        );
        write_recovery_draft_file(&path, "null").unwrap();
        assert_eq!(
            read_recovery_draft_file(&path).unwrap().as_deref(),
            Some("null")
        );
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn recovery_draft_read_errors_do_not_silently_mean_no_draft() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_recovery_draft_file(directory.path()).is_err());
        let path = directory.path().join("recovery-draft.json");
        std::fs::write(&path, [0xff]).unwrap();
        assert!(read_recovery_draft_file(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [0xff]);
    }

    #[test]
    fn settings_validation_never_changes_damaged_or_valid_original_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("papercanvas.settings.v1");
        assert!(validate_settings_file_at(&path).is_ok());
        for contents in [
            b"{}".as_slice(),
            br#"{"preferences":{"language":"en"},"draft":{"sourceMarkdown":"\u4e2d\u6587"}}"#,
        ] {
            std::fs::write(&path, contents).unwrap();
            assert!(validate_settings_file_at(&path).is_ok());
            assert_eq!(std::fs::read(&path).unwrap(), contents);
        }
        for contents in [b"{ damaged".as_slice(), b"null", b"[]", b"0", &[0xff]] {
            std::fs::write(&path, contents).unwrap();
            assert!(validate_settings_file_at(&path).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), contents);
        }
        assert!(validate_settings_file_at(directory.path()).is_err());
    }

    #[test]
    fn atomic_settings_commits_keep_original_damage_and_failed_write_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("papercanvas.settings.v1");
        let contents = br#"{"preferences":{"fontSize":22},"recentFiles":[{"path":"/notes/retained.md"}],"custom":{"writing":"Keep this key"}}"#;
        for original in [b"{ damaged".as_slice(), b"[]", b"null", &[0xff]] {
            std::fs::write(&path, original).unwrap();
            assert!(write_settings_file_at(&path, contents).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
        std::fs::write(&path, b"{}").unwrap();
        let result = replace_file_atomically_checked(&path, Some(b"{}"), |file| {
            file.write_all(b"{partial settings")?;
            Err(std::io::Error::other("simulated settings interruption"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        write_settings_file_at(&path, contents).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), contents);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_settings_commits_create_new_data_directories_and_reject_invalid_new_values() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("new-app-data/papercanvas.settings.v1");
        for contents in [b"{ damaged".as_slice(), b"[]", b"null", &[0xff]] {
            assert!(write_settings_file_at(&path, contents).is_err());
            assert!(!path.exists());
        }
        let contents = br#"{"preferences":{"fontSize":22},"custom":"Keep this key"}"#;
        write_settings_file_at(&path, contents).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), contents);
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_settings_commits_respect_read_only_original_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("papercanvas.settings.v1");
        std::fs::write(&path, br#"{"custom":"Original settings"}"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_settings_file_at(&path, br#"{"preferences":{"fontSize":22}}"#).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            br#"{"custom":"Original settings"}"#
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o444
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn settings_and_recovery_reject_named_pipes_without_waiting_for_a_writer() {
        use std::os::unix::fs::FileTypeExt;
        let directory = tempfile::tempdir().unwrap();
        for recovery in [false, true] {
            let path = directory.path().join(if recovery {
                "recovery-draft.json"
            } else {
                "papercanvas.settings.v1"
            });
            assert!(std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success());
            let (sender, receiver) = std::sync::mpsc::channel();
            let read_path = path.clone();
            let reader = std::thread::spawn(move || {
                let result = if recovery {
                    read_recovery_draft_file(&read_path).map(|_| ())
                } else {
                    validate_settings_file_at(&read_path)
                };
                sender.send(result).unwrap();
            });
            let result = receiver.recv_timeout(std::time::Duration::from_millis(250));
            if result.is_err() {
                // Bound a regression failure too: release the old blocking read.
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .write_all(b"{}")
                    .unwrap();
            }
            reader.join().unwrap();
            assert!(result
                .expect("the pipe must fail without a rescue writer")
                .is_err());
            assert!(std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_fifo());
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn regular_data_reads_reject_a_pipe_opened_after_valid_path_metadata() {
        use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("papercanvas.settings.v1");
        std::fs::write(&path, b"{}").unwrap();
        assert!(std::fs::metadata(&path).unwrap().is_file());
        // An adversarial replacement makes the prior pathname check stale.
        std::fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(&path)
            .unwrap();
        let error = read_regular_file_contents(file).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_fifo());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn document_write_access_rejects_a_replacement_pipe_without_a_rescue_reader() {
        use std::os::unix::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.md");
        std::fs::write(&path, b"Original writing").unwrap();
        assert!(std::fs::metadata(&path).unwrap().is_file());
        std::fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let write_path = path.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            sender
                .send(check_regular_file_write_access(&write_path))
                .unwrap();
        });
        let result = receiver.recv_timeout(std::time::Duration::from_millis(250));
        if result.is_err() {
            // Bound the old blocking-write regression too.
            let _rescue = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
                .open(&path)
                .unwrap();
            writer.join().unwrap();
        } else {
            writer.join().unwrap();
        }
        assert!(result
            .expect("write access must fail without a rescue reader")
            .is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn document_write_access_rejects_an_open_pipe_and_retains_regular_file_bytes() {
        use std::os::unix::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.md");
        std::fs::write(&path, b"Original writing").unwrap();
        check_regular_file_write_access(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"Original writing");
        std::fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let _reader = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(&path)
            .unwrap();
        assert_eq!(
            check_regular_file_write_access(&path).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn markdown_saves_replace_whole_documents_and_support_long_unicode_names() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join(format!("{}研究.md", "n".repeat(230)));
        for contents in ["# Original\r\n", "", "# 研究 🧪\r\n\nMixed\rseparators\0"] {
            replace_file_atomically(&target, |file| file.write_all(contents.as_bytes())).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), contents.as_bytes());
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_markdown_destination_keeps_directory_and_removes_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        std::fs::create_dir(&target).unwrap();
        assert!(replace_file_atomically(&target, |file| file.write_all(b"contents")).is_err());
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_markdown_saves_preserve_permissions_and_document_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        let link = directory.path().join("linked.md");
        std::fs::write(&target, "old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        replace_file_atomically(&link, |file| file.write_all(b"new")).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_markdown_saves_respect_permissions_changed_during_preparation() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        for mode in [0o444, 0o600] {
            std::fs::write(&target, "Original writing").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
            let result =
                replace_file_atomically_checked(&target, Some(b"Original writing"), |file| {
                    file.write_all(b"Our later edit")?;
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
                });
            if mode == 0o444 {
                assert!(result.is_err());
                assert_eq!(std::fs::read(&target).unwrap(), b"Original writing");
            } else {
                result.unwrap();
                assert_eq!(std::fs::read(&target).unwrap(), b"Our later edit");
            }
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                mode
            );
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
    }

    #[test]
    fn overlapping_markdown_writes_leave_one_complete_document() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("research.md");
        std::fs::write(&target, "old").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let expected: Vec<String> = (0..12)
            .map(|index| format!("# Revision {index}\n{}", "中文 🧪\n".repeat(10_000)))
            .collect();
        let writers: Vec<_> = expected
            .iter()
            .map(|contents| {
                let target = target.clone();
                let barrier = barrier.clone();
                let contents = contents.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    replace_file_atomically(&target, |file| file.write_all(contents.as_bytes()))
                        .unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let result = std::fs::read_to_string(&target).unwrap();
        assert!(expected.contains(&result));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

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
    fn rename_authorizes_only_a_granted_markdown_documents_siblings() {
        let root = std::env::temp_dir();
        let source = root.join("research.md");
        for (name, assets) in [
            ("renamed.MD", "renamed.assets"),
            ("renamed.markdown", "renamed.markdown.assets"),
        ] {
            assert_eq!(
                document_rename_asset_directories(&source, &root.join(name), true).unwrap(),
                [root.join("research.assets"), root.join(assets)]
            );
        }
        assert!(
            document_rename_asset_directories(&source, &root.join("renamed.md"), false).is_err()
        );
        for target in [
            PathBuf::from("relative.md"),
            root.join("../outside.md"),
            root.join("other/renamed.md"),
            root.join("renamed.txt"),
        ] {
            assert!(document_rename_asset_directories(&source, &target, true).is_err());
        }
        assert!(document_rename_asset_directories(
            &root.join("../research.md"),
            &root.join("renamed.md"),
            true
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rename_rejects_symlinked_companion_folders_and_target_documents() {
        let root = std::env::temp_dir().join(format!("papercanvas-rename-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("research.md");
        let target = root.join("renamed.md");
        for name in ["research.assets", "renamed.assets", "renamed.md"] {
            let link = root.join(name);
            std::os::unix::fs::symlink(std::env::temp_dir(), &link).unwrap();
            assert!(document_rename_asset_directories(&source, &target, true).is_err());
            std::fs::remove_file(link).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
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
    fn direct_pdf_export_rejects_embedded_eof_tokens_and_accepts_final_trailer_whitespace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial.pdf");
        for contents in [
            b"%PDF-1.7\n1 0 obj\nstream\nUnfinished object with %%EOF literal\n".as_slice(),
            b"%PDF-1.7\n1 0 obj\nstream\nAn embedded %%EOF\n",
            b"%PDF-1.7\nstartxref\n30\n%%EOF\nMore bytes are being written",
        ] {
            std::fs::write(&path, contents).unwrap();
            assert_eq!(pdf_has_complete_trailer(&path).unwrap(), None);
        }
        for contents in [
            b"%PDF-1.7\nstartxref\n30\n%%EOF".as_slice(),
            b"%PDF-1.7\r\nstartxref\r\n30\r\n \t%%EOF\r\n \t\x0c\0",
            b"%PDF-1.7\rstartxref\r30\r%%EOF\r",
        ] {
            std::fs::write(&path, contents).unwrap();
            assert_eq!(
                pdf_has_complete_trailer(&path).unwrap(),
                Some(contents.len() as u64)
            );
        }
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
            .is_some_and(|name| name.starts_with(".papercanvas-") && name.ends_with(".tmp.pdf")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn direct_pdf_export_temporary_files_support_long_unicode_destination_names() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            format!("{}.pdf", "n".repeat(240)),
            format!("{}.pdf", "研究".repeat(40)),
        ] {
            let target = directory.path().join(name);
            std::fs::write(&target, b"Original chosen PDF").unwrap();
            let temporary = temporary_pdf_path(&target).unwrap();
            let contents = b"%PDF-1.4\nNew export\n%%EOF\n";
            std::fs::write(&temporary, contents).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"Original chosen PDF");
            std::fs::rename(&temporary, &target).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), contents);
            std::fs::remove_file(&target).unwrap();
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
