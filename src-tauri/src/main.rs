#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
mod single_instance;
mod tray;

use base64::{engine::general_purpose, Engine as _};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use platform::{capture_client_rgb, current_process_elevated, list_windows, RgbFrame};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewImage {
    width: u32,
    height: u32,
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedPreviewImage {
    width: u32,
    height: u32,
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResult {
    saved_path: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegeStatus {
    current_process_elevated: bool,
    note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameLaunchConfig {
    #[serde(default)]
    exe_path: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    working_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameLaunchResult {
    launched: bool,
    pid: u32,
    exe_path: String,
    args: Vec<String>,
    working_dir: Option<String>,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameLaunchStatus {
    configured: bool,
    source: String,
    exe_path: Option<String>,
    exe_exists: bool,
    args: Vec<String>,
    working_dir: Option<String>,
    working_dir_exists: Option<bool>,
    config_path: String,
    example_path: String,
    message: String,
}

#[tauri::command]
fn list_game_windows(title_needle: String) -> Result<Vec<platform::AppWindow>, String> {
    list_windows(&title_needle)
}

#[tauri::command]
fn privilege_status() -> PrivilegeStatus {
    let elevated = current_process_elevated();
    PrivilegeStatus {
        current_process_elevated: elevated,
        note: if elevated {
            "编排器已以管理员权限运行，可以操作同级或低权限目标窗口。".to_string()
        } else {
            "编排器不是管理员权限；如果目标窗口是管理员权限，截图和后台消息可能被 Windows 拦截。"
                .to_string()
        },
    }
}

#[tauri::command]
fn restart_as_admin() -> Result<(), String> {
    platform::restart_current_process_as_admin()?;
    std::process::exit(0);
}

#[tauri::command]
fn launch_game_client() -> Result<GameLaunchResult, String> {
    launch_configured_game_client()
}

#[tauri::command]
fn game_launch_status() -> Result<GameLaunchStatus, String> {
    let project = project_root()?;
    let config = read_game_launch_config(&project)?;
    Ok(build_game_launch_status(&project, &config))
}

#[tauri::command]
fn capture_window_preview(hwnd: isize) -> Result<PreviewImage, String> {
    let frame = capture_client_rgb(hwnd)?;
    let png = encode_png(&frame)?;
    Ok(PreviewImage {
        width: frame.width,
        height: frame.height,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ),
    })
}

#[tauri::command]
fn save_window_snapshot(hwnd: isize) -> Result<SnapshotResult, String> {
    let frame = capture_client_rgb(hwnd)?;
    let root = project_root()?;
    let dir = root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("captures");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join(format!("window-{}.png", timestamp()));
    save_png(&frame, &path)?;
    Ok(SnapshotResult {
        saved_path: path.display().to_string(),
        width: frame.width,
        height: frame.height,
    })
}

#[tauri::command]
fn import_preview_image(
    image_path: String,
    save_copy: bool,
) -> Result<ImportedPreviewImage, String> {
    let frame = load_image_rgb(Path::new(&image_path))?;
    if save_copy {
        let root = project_root()?;
        let dir = root
            .join("assets")
            .join("resource")
            .join("ShiKong")
            .join("captures");
        fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        let path = dir.join(format!("imported-{}.png", timestamp()));
        save_png(&frame, &path)?;
    }
    let png = encode_png(&frame)?;
    Ok(ImportedPreviewImage {
        width: frame.width,
        height: frame.height,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ),
    })
}

fn project_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve MHXY-ShiKong-Control project root".to_string())
}

fn launch_configured_game_client() -> Result<GameLaunchResult, String> {
    let project = project_root()?;
    let config = read_game_launch_config(&project)?;
    let status = build_game_launch_status(&project, &config);
    if !status.configured {
        return Err(status.message);
    }
    let exe_path = PathBuf::from(
        status
            .exe_path
            .as_deref()
            .ok_or_else(|| "客户端 exe 路径为空".to_string())?,
    );
    let working_dir = status.working_dir.as_deref().map(PathBuf::from);
    let mut command = Command::new(&exe_path);
    command.args(&config.args);
    if let Some(dir) = working_dir.as_ref() {
        command.current_dir(dir);
    }
    let child = command
        .spawn()
        .map_err(|err| format!("启动客户端失败 {}: {err}", exe_path.display()))?;
    Ok(GameLaunchResult {
        launched: true,
        pid: child.id(),
        exe_path: exe_path.display().to_string(),
        args: config.args,
        working_dir: working_dir.map(|path| path.display().to_string()),
        detail: "已启动配置的梦幻西游：时空客户端；稍后刷新窗口列表进行接管".to_string(),
    })
}

fn build_game_launch_status(project: &Path, config: &GameLaunchConfig) -> GameLaunchStatus {
    let env_exe = env::var("SHIKONG_GAME_EXE")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let (source, exe_value) = if let Some(value) = env_exe {
        ("SHIKONG_GAME_EXE".to_string(), Some(value))
    } else if let Some(value) = config
        .exe_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        ("app_launch.json".to_string(), Some(value.to_string()))
    } else {
        ("none".to_string(), None)
    };
    let exe_path = exe_value
        .as_deref()
        .map(|value| resolve_project_path(project, value));
    let exe_exists = exe_path.as_ref().is_some_and(|path| path.is_file());
    let working_dir_path = config
        .working_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_project_path(project, value));
    let working_dir_exists = working_dir_path.as_ref().map(|path| path.is_dir());
    let configured = exe_path.is_some() && exe_exists && working_dir_exists.unwrap_or(true);
    let message = if configured {
        format!(
            "客户端启动配置有效：{}",
            exe_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        )
    } else if exe_path.is_none() {
        format!(
            "未配置客户端路径；请设置 SHIKONG_GAME_EXE 或复制 {} 为 app_launch.json 并填写 exePath",
            game_launch_example_path(project).display()
        )
    } else if !exe_exists {
        format!(
            "客户端 exe 不存在：{}",
            exe_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        )
    } else {
        format!(
            "工作目录不存在：{}",
            working_dir_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        )
    };
    GameLaunchStatus {
        configured,
        source,
        exe_path: exe_path.map(|path| path.display().to_string()),
        exe_exists,
        args: config.args.clone(),
        working_dir: working_dir_path
            .as_ref()
            .map(|path| path.display().to_string()),
        working_dir_exists,
        config_path: game_launch_config_path(project).display().to_string(),
        example_path: game_launch_example_path(project).display().to_string(),
        message,
    }
}

fn read_game_launch_config(project: &Path) -> Result<GameLaunchConfig, String> {
    let path = game_launch_config_path(project);
    if !path.is_file() {
        return Ok(GameLaunchConfig {
            exe_path: None,
            args: Vec::new(),
            working_dir: None,
        });
    }
    let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

fn game_launch_config_path(project: &Path) -> PathBuf {
    project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("app_launch.json")
}

fn game_launch_example_path(project: &Path) -> PathBuf {
    project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("app_launch.example.json")
}

fn resolve_project_path(project: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        path
    } else {
        project.join(path)
    }
}

fn save_png(frame: &RgbFrame, path: &Path) -> Result<(), String> {
    let bytes = encode_png(frame)?;
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn load_image_rgb(path: &Path) -> Result<RgbFrame, String> {
    let image = image::ImageReader::open(path)
        .map_err(|err| format!("{}: {err}", path.display()))?
        .decode()
        .map_err(|err| format!("{}: {err}", path.display()))?
        .to_rgb8();
    Ok(RgbFrame {
        width: image.width(),
        height: image.height(),
        pixels: image.into_raw(),
    })
}

fn encode_png(frame: &RgbFrame) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            &frame.pixels,
            frame.width,
            frame.height,
            ColorType::Rgb8.into(),
        )
        .map_err(|err| err.to_string())?;
    Ok(bytes)
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn main() {
    platform::configure_process_dpi_awareness();
    if single_instance::notify_existing_instance(single_instance::DEFAULT_NOTIFY_TIMEOUT) {
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            tray::setup(app)?;
            let app_handle = app.handle().clone();
            match single_instance::start_listener(move || {
                let handle = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    tray::show_main_window(&handle);
                });
            }) {
                Ok(guard) => {
                    app.manage(guard);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                    if single_instance::notify_existing_instance(
                        single_instance::DEFAULT_NOTIFY_TIMEOUT,
                    ) {
                        app.handle().exit(0);
                    }
                }
                Err(_) => {}
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            tray::handle_window_event(window, event);
        })
        .on_menu_event(|app, event| {
            tray::handle_menu_event(app, event);
        })
        .invoke_handler(tauri::generate_handler![
            list_game_windows,
            privilege_status,
            restart_as_admin,
            launch_game_client,
            game_launch_status,
            capture_window_preview,
            save_window_snapshot,
            import_preview_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running shikong workflow app");
}
