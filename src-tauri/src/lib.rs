use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_fs::FsExt;

struct OpenedFiles(Mutex<Vec<String>>);

fn supported_markdown_path(path: PathBuf) -> Option<PathBuf> {
    let extension = path.extension()?.to_string_lossy();
    if !matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") || !path.is_file() {
        return None;
    }
    Some(path.canonicalize().unwrap_or(path))
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
        .invoke_handler(tauri::generate_handler![take_opened_files])
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
}
