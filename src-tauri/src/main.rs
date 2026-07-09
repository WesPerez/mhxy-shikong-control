#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
mod single_instance;
mod tray;

use base64::{engine::general_purpose, Engine as _};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use platform::{
    capture_client_rgb, capture_client_rgb_strict, current_process_elevated, list_windows,
    post_hotkey, post_mouse_click, post_mouse_double_click, post_text, window_for_hwnd, HwndPoint,
    RgbFrame,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

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
struct BuiltinTargetTemplate {
    key: String,
    replacement_path: String,
    width: u32,
    height: u32,
    data_url: String,
    source_roi: Option<Vec<u32>>,
    source_frame_width: Option<u32>,
    source_frame_height: Option<u32>,
    match_score: Option<f32>,
    note: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowWorkspace {
    path: String,
    existed: bool,
    data: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowWorkspaceSave {
    saved_path: String,
    backup_path: Option<String>,
    bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowStepInput {
    #[serde(rename = "type")]
    step_type: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    expect: String,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    target_kind: Option<String>,
    #[serde(default)]
    target_data_url: Option<String>,
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    asset_kind: Option<String>,
    #[serde(default)]
    asset_data_url: Option<String>,
    #[serde(default)]
    roi: Option<RoiRect>,
    #[serde(default)]
    target_texts: Vec<String>,
    #[serde(default)]
    ocr_language: Option<String>,
    #[serde(default)]
    ocr_region: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedWindowInput {
    #[serde(default)]
    hwnd: Option<isize>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    process_id: Option<u32>,
    #[serde(default)]
    process_name: Option<String>,
    #[serde(default)]
    client_width: Option<u32>,
    #[serde(default)]
    client_height: Option<u32>,
    #[serde(default)]
    elevated: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepDispatchResult {
    hwnd: isize,
    step_type: String,
    status: String,
    action: String,
    detail: String,
    input_sent: bool,
    matched: bool,
    x: Option<u32>,
    y: Option<u32>,
    score: Option<f32>,
}

#[derive(Debug, Clone)]
struct TemplateMatch {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    score: f32,
}

const WORKSPACE_SCHEMA_VERSION: u32 = 9;
const DEFAULT_IMAGE_THRESHOLD: f32 = 0.86;
const MAX_TEMPLATE_DATA_URL_CHARS: usize = 5 * 1024 * 1024;
const MAX_TEMPLATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEMPLATE_PIXELS: u64 = 2_000_000;
const MAX_OCR_PIXELS: u64 = 4_000_000;
const MAX_TEXT_INPUT_CHARS: usize = 500;
const WINDOW_CLIENT_SIZE_TOLERANCE: u32 = 2;
const TARGET_TITLE_NEEDLE: &str = "梦幻西游：时空";

#[tauri::command]
fn list_game_windows(title_needle: String) -> Result<Vec<platform::AppWindow>, String> {
    list_windows(&title_needle)
}

#[tauri::command]
fn current_window_identity(hwnd: isize) -> Result<platform::AppWindow, String> {
    target_window_for_hwnd(hwnd)
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
fn load_workflow_workspace(app: tauri::AppHandle) -> Result<WorkflowWorkspace, String> {
    let path = workflow_workspace_path(&app)?;
    let existed = path.is_file();
    let data = if existed {
        let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
        serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))?
    } else {
        default_workflow_workspace()
    };
    Ok(WorkflowWorkspace {
        path: path.display().to_string(),
        existed,
        data,
    })
}

#[tauri::command]
fn save_workflow_workspace(
    app: tauri::AppHandle,
    workspace: Value,
) -> Result<WorkflowWorkspaceSave, String> {
    let path = workflow_workspace_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&workspace).map_err(|err| err.to_string())?;
    let backup_path = atomic_write_workspace_json(&path, text.as_bytes())?;
    Ok(WorkflowWorkspaceSave {
        saved_path: path.display().to_string(),
        backup_path: backup_path.map(|path| path.display().to_string()),
        bytes: text.len(),
    })
}

fn atomic_write_workspace_json(path: &Path, bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{}: workspace path has no parent", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{}: workspace file name is invalid", path.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let tmp_path = parent.join(format!(".{file_name}.{stamp}.tmp"));
    let backup_path = path.with_extension("json.bak");

    let write_result = (|| -> Result<Option<PathBuf>, String> {
        let mut file =
            fs::File::create(&tmp_path).map_err(|err| format!("{}: {err}", tmp_path.display()))?;
        file.write_all(bytes)
            .map_err(|err| format!("{}: {err}", tmp_path.display()))?;
        file.sync_all()
            .map_err(|err| format!("{}: {err}", tmp_path.display()))?;
        drop(file);

        let backup_path = if path.exists() {
            fs::copy(path, &backup_path)
                .map_err(|err| format!("{} -> {}: {err}", path.display(), backup_path.display()))?;
            Some(backup_path)
        } else {
            None
        };
        replace_file_with_temp(&tmp_path, path)?;
        Ok(backup_path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

#[cfg(windows)]
fn replace_file_with_temp(tmp_path: &Path, path: &Path) -> Result<(), String> {
    let from = wide_path(tmp_path);
    let to = wide_path(path);
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|err| format!("{} -> {}: {err}", tmp_path.display(), path.display()))
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(windows))]
fn replace_file_with_temp(tmp_path: &Path, path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|err| format!("{}: {err}", path.display()))?;
    }
    fs::rename(tmp_path, path)
        .map_err(|err| format!("{} -> {}: {err}", tmp_path.display(), path.display()))
}

#[tauri::command]
fn execute_workflow_step(
    hwnd: isize,
    step: WorkflowStepInput,
    expected_window: Option<ExpectedWindowInput>,
) -> Result<StepDispatchResult, String> {
    let expected_window = expected_window.as_ref();
    validate_expected_window(hwnd, expected_window)?;
    let step_type = step.step_type.trim().to_ascii_lowercase();
    let mut result = match step_type.as_str() {
        "hotkey" => dispatch_hotkey_step(hwnd, &step),
        "text_input" => dispatch_text_input_step(hwnd, &step),
        "click" => dispatch_click_step(hwnd, &step, MouseDispatchMode::Click),
        "double_click" => {
            if template_data_url(&step).is_some() || step.roi.is_some() {
                dispatch_image_step(hwnd, &step, MouseDispatchMode::DoubleClick, expected_window)
            } else {
                dispatch_click_step(hwnd, &step, MouseDispatchMode::DoubleClick)
            }
        }
        "image_click" => {
            dispatch_image_step(hwnd, &step, MouseDispatchMode::Click, expected_window)
        }
        "wait_image" | "detect_page" => {
            dispatch_image_step(hwnd, &step, MouseDispatchMode::MatchOnly, None)
        }
        "snapshot" => {
            let frame = capture_client_rgb(hwnd)?;
            Ok(step_result(
                hwnd,
                &step.step_type,
                "observed",
                "snapshot",
                format!(
                    "captured {}x{} for step verification",
                    frame.width, frame.height
                ),
            ))
        }
        "delay" | "condition" | "loop" | "retry_until" | "task_jump" | "restore" => {
            Ok(step_result(
                hwnd,
                &step.step_type,
                "planned",
                "no_input",
                "step is represented in the runner but has no direct backend input in this build",
            ))
        }
        "ocr_assert" => dispatch_ocr_step(hwnd, &step),
        other => Ok(step_result(
            hwnd,
            other,
            "unsupported",
            "unknown",
            format!("unsupported step type: {other}"),
        )),
    }?;
    append_step_metadata(&mut result, &step);
    Ok(result)
}

#[tauri::command]
fn capture_window_preview(
    hwnd: isize,
    expected_window: Option<ExpectedWindowInput>,
) -> Result<PreviewImage, String> {
    validate_expected_window(hwnd, expected_window.as_ref())?;
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
fn save_window_snapshot(
    hwnd: isize,
    expected_window: Option<ExpectedWindowInput>,
) -> Result<SnapshotResult, String> {
    validate_expected_window(hwnd, expected_window.as_ref())?;
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

#[tauri::command]
fn import_clipboard_image() -> Result<ImportedPreviewImage, String> {
    let frame = read_clipboard_rgb_frame()?;
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

#[tauri::command]
fn load_builtin_target_templates(keys: Vec<String>) -> Result<Vec<BuiltinTargetTemplate>, String> {
    let root = project_root()?;
    let mapping_path = root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("template_mapping.json");
    let text = fs::read_to_string(&mapping_path)
        .map_err(|err| format!("{}: {err}", mapping_path.display()))?;
    let mapping: Value =
        serde_json::from_str(&text).map_err(|err| format!("{}: {err}", mapping_path.display()))?;
    let templates = mapping
        .get("templates")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{}: templates object missing", mapping_path.display()))?;

    let mut loaded = Vec::new();
    let mut seen = Vec::new();
    for raw_key in keys {
        let key = raw_key.trim().replace('\\', "/");
        if key.is_empty() || seen.iter().any(|item: &String| item == &key) {
            continue;
        }
        seen.push(key.clone());
        let Some(entry) = templates.get(&key) else {
            continue;
        };
        let Some(replacement_path) = entry.get("replacementPath").and_then(Value::as_str) else {
            continue;
        };
        let image_path = root.join(replacement_path);
        if !image_path.is_file() {
            continue;
        }
        let frame = load_image_rgb(&image_path)?;
        let png = encode_png(&frame)?;
        loaded.push(BuiltinTargetTemplate {
            key,
            replacement_path: replacement_path.to_string(),
            width: frame.width,
            height: frame.height,
            data_url: format!(
                "data:image/png;base64,{}",
                general_purpose::STANDARD.encode(png)
            ),
            source_roi: entry.get("sourceRoi").and_then(json_u32_array),
            source_frame_width: json_u32(entry.get("sourceFrameWidth")),
            source_frame_height: json_u32(entry.get("sourceFrameHeight")),
            match_score: json_f32(entry.get("matchScore")),
            note: entry
                .get("note")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(loaded)
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
}

fn json_f32(value: Option<&Value>) -> Option<f32> {
    value.and_then(Value::as_f64).map(|number| number as f32)
}

fn json_u32_array(value: &Value) -> Option<Vec<u32>> {
    let items = value.as_array()?;
    let values = items
        .iter()
        .map(|item| json_u32(Some(item)))
        .collect::<Option<Vec<_>>>()?;
    (values.len() == 4).then_some(values)
}

fn project_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve MHXY-ShiKong-Control project root".to_string())
}

fn workflow_workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    dir.push("workspace.json");
    Ok(dir)
}

fn default_workflow_workspace() -> Value {
    json!({
        "schemaVersion": WORKSPACE_SCHEMA_VERSION,
        "activeWorkflowId": null,
        "workflows": [],
        "assignments": {},
        "targets": [],
        "runHistory": []
    })
}

fn validate_expected_window(
    hwnd: isize,
    expected: Option<&ExpectedWindowInput>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Err("expected window identity is required for background dispatch".to_string());
    };
    validate_expected_window_argument(hwnd, expected)?;
    let current = target_window_for_hwnd(hwnd)?;
    compare_expected_window(&current, expected)?;
    validate_dispatch_privilege(&current)
}

fn validate_expected_window_argument(
    hwnd: isize,
    expected: &ExpectedWindowInput,
) -> Result<(), String> {
    let expected_hwnd = expected.hwnd.filter(|value| *value != 0).ok_or_else(|| {
        "expected window identity must include hwnd for background dispatch".to_string()
    })?;
    if expected_hwnd != hwnd {
        return Err(format!(
            "target window identity mismatch: hwnd argument {} does not match expectedWindow.hwnd {}",
            hwnd, expected_hwnd
        ));
    }
    let title = non_empty_option(expected.title.as_deref()).ok_or_else(|| {
        "expected window identity must include title for background dispatch".to_string()
    })?;
    if !title.contains(TARGET_TITLE_NEEDLE) {
        return Err(format!(
            "target window identity mismatch: title {:?} does not contain {:?}",
            title, TARGET_TITLE_NEEDLE
        ));
    }
    expected
        .process_id
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            "expected window identity must include processId for background dispatch".to_string()
        })?;
    non_empty_option(expected.process_name.as_deref()).ok_or_else(|| {
        "expected window identity must include processName for background dispatch".to_string()
    })?;
    expected
        .client_width
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            "expected window identity must include clientWidth for background dispatch".to_string()
        })?;
    expected
        .client_height
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            "expected window identity must include clientHeight for background dispatch".to_string()
        })?;
    expected.elevated.ok_or_else(|| {
        "expected window identity must include elevated for background dispatch".to_string()
    })?;
    Ok(())
}

fn compare_expected_window(
    current: &platform::AppWindow,
    expected: &ExpectedWindowInput,
) -> Result<(), String> {
    validate_expected_window_argument(current.hwnd, expected)?;
    let hwnd = expected.hwnd.unwrap_or_default();
    if current.hwnd != hwnd {
        return Err(format!(
            "target window identity mismatch: hwnd changed from {} to {}",
            hwnd, current.hwnd
        ));
    }
    let title = non_empty_option(expected.title.as_deref()).unwrap_or_default();
    if current.title != title {
        return Err(format!(
            "target window identity mismatch: title changed from {:?} to {:?}",
            title, current.title
        ));
    }
    let process_id = expected.process_id.unwrap_or_default();
    if current.process_id != process_id {
        return Err(format!(
            "target window identity mismatch: pid changed from {} to {}",
            process_id, current.process_id
        ));
    }
    let process_name = non_empty_option(expected.process_name.as_deref()).unwrap_or_default();
    if !current.process_name.eq_ignore_ascii_case(process_name) {
        return Err(format!(
            "target window identity mismatch: process changed from {:?} to {:?}",
            process_name, current.process_name
        ));
    }
    let client_width = expected.client_width.unwrap_or_default();
    if current.client_width.abs_diff(client_width) > WINDOW_CLIENT_SIZE_TOLERANCE {
        return Err(format!(
            "target window identity mismatch: client width changed from {} to {}",
            client_width, current.client_width
        ));
    }
    let client_height = expected.client_height.unwrap_or_default();
    if current.client_height.abs_diff(client_height) > WINDOW_CLIENT_SIZE_TOLERANCE {
        return Err(format!(
            "target window identity mismatch: client height changed from {} to {}",
            client_height, current.client_height
        ));
    }
    let elevated = expected.elevated.unwrap_or(false);
    if current.elevated != Some(elevated) {
        return Err(format!(
            "target window identity mismatch: elevation changed from {:?} to {:?}",
            Some(elevated),
            current.elevated
        ));
    }
    Ok(())
}

fn target_window_for_hwnd(hwnd: isize) -> Result<platform::AppWindow, String> {
    let window = window_for_hwnd(hwnd)?;
    validate_target_window_record(&window)?;
    Ok(window)
}

fn validate_target_window_record(window: &platform::AppWindow) -> Result<(), String> {
    if !window.title.contains(TARGET_TITLE_NEEDLE) {
        return Err(format!(
            "target window rejected: title {:?} does not contain {:?}",
            window.title, TARGET_TITLE_NEEDLE
        ));
    }
    Ok(())
}

fn validate_dispatch_privilege(window: &platform::AppWindow) -> Result<(), String> {
    if window.elevated == Some(true) && !current_process_elevated() {
        return Err(format!(
            "administrator privileges required: target hwnd {} is elevated but this process is not",
            window.hwnd
        ));
    }
    Ok(())
}

fn non_empty_option(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseDispatchMode {
    MatchOnly,
    Click,
    DoubleClick,
}

impl MouseDispatchMode {
    fn sends_input(self) -> bool {
        !matches!(self, Self::MatchOnly)
    }

    fn image_action(self) -> &'static str {
        match self {
            Self::MatchOnly => "image_match",
            Self::Click => "image_click",
            Self::DoubleClick => "image_double_click",
        }
    }

    fn roi_action(self) -> &'static str {
        match self {
            Self::MatchOnly => "roi_match",
            Self::Click => "roi_click",
            Self::DoubleClick => "roi_double_click",
        }
    }

    fn click_action(self) -> &'static str {
        match self {
            Self::MatchOnly => "image_match",
            Self::Click => "click",
            Self::DoubleClick => "double_click",
        }
    }
}

fn dispatch_hotkey_step(
    hwnd: isize,
    step: &WorkflowStepInput,
) -> Result<StepDispatchResult, String> {
    let hotkey = first_non_empty([step.target.as_str(), step.command.as_str()])
        .ok_or_else(|| "hotkey step requires target or command".to_string())?;
    let result = post_hotkey(hwnd, hotkey)?;
    Ok(step_result_with_input(
        hwnd,
        &step.step_type,
        "sent",
        "hotkey",
        result.detail,
        true,
        None,
    ))
}

fn dispatch_text_input_step(
    hwnd: isize,
    step: &WorkflowStepInput,
) -> Result<StepDispatchResult, String> {
    let text = text_input_value(step)?;
    let result = post_text(hwnd, text)?;
    Ok(step_result_with_input(
        hwnd,
        &step.step_type,
        "sent",
        "text_input",
        result.detail,
        true,
        None,
    ))
}

fn dispatch_click_step(
    hwnd: isize,
    step: &WorkflowStepInput,
    mode: MouseDispatchMode,
) -> Result<StepDispatchResult, String> {
    let point = point_from_step(step).ok_or_else(|| {
        format!(
            "{} step requires target x=...,y=... or an ROI-bound asset",
            mode.click_action()
        )
    })?;
    let button = command_value(&step.command, "button").unwrap_or("left");
    let result = match mode {
        MouseDispatchMode::DoubleClick => post_mouse_double_click(hwnd, point.clone(), button)?,
        _ => post_mouse_click(hwnd, point.clone(), button)?,
    };
    let mut output = step_result_with_input(
        hwnd,
        &step.step_type,
        "sent",
        mode.click_action(),
        result.detail,
        true,
        None,
    );
    output.x = Some(point.x);
    output.y = Some(point.y);
    Ok(output)
}

fn dispatch_image_step(
    hwnd: isize,
    step: &WorkflowStepInput,
    mode: MouseDispatchMode,
    expected_window: Option<&ExpectedWindowInput>,
) -> Result<StepDispatchResult, String> {
    let button = command_value(&step.command, "button").unwrap_or("left");
    let threshold = image_threshold(step)?;
    if let Some(data_url) = template_data_url(step) {
        let frame = if mode.sends_input() {
            capture_client_rgb_strict(hwnd)?
        } else {
            capture_client_rgb(hwnd)?
        };
        let template = load_image_data_url_rgb(data_url)?;
        let search_roi = scaled_roi(step.roi, frame.width, frame.height);
        let matched = match_template(&frame, &template, search_roi)?;
        let click_point = image_click_point(&matched, step, frame.width, frame.height)?;
        let mut output = step_result_with_input(
            hwnd,
            &step.step_type,
            if matched.score >= threshold {
                if mode.sends_input() {
                    "sent"
                } else {
                    "matched"
                }
            } else {
                "below_threshold"
            },
            mode.image_action(),
            format!(
                "best score {:.3} at {},{} size {}x{} threshold {:.3}",
                matched.score, matched.x, matched.y, matched.width, matched.height, threshold
            ),
            false,
            Some(matched.score),
        );
        output.matched = matched.score >= threshold;
        output.x = Some(click_point.x);
        output.y = Some(click_point.y);
        if mode.sends_input() && matched.score >= threshold {
            validate_expected_window(hwnd, expected_window)?;
            let result = match mode {
                MouseDispatchMode::DoubleClick => {
                    post_mouse_double_click(hwnd, click_point, button)?
                }
                _ => post_mouse_click(hwnd, click_point, button)?,
            };
            output.input_sent = true;
            output.detail = format!("{}; {}", output.detail, result.detail);
        }
        return Ok(output);
    }

    if let Some(point) = point_from_step_with_offset(step)? {
        if mode.sends_input() {
            validate_expected_window(hwnd, expected_window)?;
            let result = match mode {
                MouseDispatchMode::DoubleClick => {
                    post_mouse_double_click(hwnd, point.clone(), button)?
                }
                _ => post_mouse_click(hwnd, point.clone(), button)?,
            };
            let mut output = step_result_with_input(
                hwnd,
                &step.step_type,
                "sent",
                mode.roi_action(),
                result.detail,
                true,
                None,
            );
            output.matched = true;
            output.x = Some(point.x);
            output.y = Some(point.y);
            return Ok(output);
        }
        let mut output = step_result(
            hwnd,
            &step.step_type,
            "planned",
            mode.roi_action(),
            "ROI target is available, but no template image is bound for visual matching",
        );
        output.matched = true;
        output.x = Some(point.x);
        output.y = Some(point.y);
        return Ok(output);
    }

    Ok(step_result(
        hwnd,
        &step.step_type,
        "missing_asset",
        mode.image_action(),
        "image step requires a pasted image asset or ROI target",
    ))
}

fn dispatch_ocr_step(hwnd: isize, step: &WorkflowStepInput) -> Result<StepDispatchResult, String> {
    let expected_texts = expected_ocr_texts(step);
    if expected_texts.is_empty() {
        return Ok(step_result(
            hwnd,
            &step.step_type,
            "missing_expect",
            "ocr",
            "OCR step requires targetTexts, target text, expect text, or command text=...",
        ));
    }

    let frame = capture_client_rgb(hwnd)?;
    let roi = ocr_search_roi(step, frame.width, frame.height);
    let crop = crop_frame(&frame, roi)?;
    let language = ocr_language_tag(step);
    match recognize_ocr_text(&crop, language.as_deref()) {
        Ok(recognized) => {
            let matched_text = matched_ocr_text(&recognized, &expected_texts);
            let mut output = step_result(
                hwnd,
                &step.step_type,
                if matched_text.is_some() {
                    "matched"
                } else {
                    "text_miss"
                },
                "ocr",
                format!(
                    "recognized=\"{}\"; expected={}; lang={}; roi={}",
                    summarize_text(&recognized, 160),
                    expected_texts.join("|"),
                    language.as_deref().unwrap_or("user-profile"),
                    roi_label(roi)
                ),
            );
            output.matched = matched_text.is_some();
            Ok(output)
        }
        Err(err) => {
            let mut output = step_result(
                hwnd,
                &step.step_type,
                "ocr_unavailable",
                "ocr",
                format!(
                    "Windows OCR unavailable: {err}; expected={}; lang={}; roi={}",
                    expected_texts.join("|"),
                    language.as_deref().unwrap_or("user-profile"),
                    roi_label(roi)
                ),
            );
            output.matched = false;
            Ok(output)
        }
    }
}

fn expected_ocr_texts(step: &WorkflowStepInput) -> Vec<String> {
    let mut texts = Vec::new();
    for value in &step.target_texts {
        push_ocr_text_candidate(&mut texts, value);
    }
    if texts.is_empty() {
        push_ocr_text_candidate(&mut texts, &step.target);
    }
    push_ocr_text_candidate(&mut texts, &step.expect);
    if let Some(value) = command_value(&step.command, "text")
        .or_else(|| command_value(&step.command, "contains"))
        .or_else(|| command_value(&step.command, "expect"))
    {
        push_ocr_text_candidate(&mut texts, value);
    }
    texts
}

fn push_ocr_text_candidate(texts: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() || is_generic_ocr_expectation(value) {
        return;
    }
    if !texts.iter().any(|item| item.eq_ignore_ascii_case(value)) {
        texts.push(value.to_string());
    }
}

fn is_generic_ocr_expectation(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.is_empty()
        || normalized.starts_with("text.")
        || matches!(
            normalized.as_str(),
            "text_found"
                | "text.visible"
                | "found"
                | "visible"
                | "ready"
                | "ready=true"
                | "screen.changed"
                | "panel.open"
        )
}

fn ocr_language_tag(step: &WorkflowStepInput) -> Option<String> {
    let raw = step
        .ocr_language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| command_value(&step.command, "lang"))
        .or_else(|| command_value(&step.command, "language"))?
        .trim();
    if raw.is_empty() {
        return None;
    }
    match raw.to_ascii_lowercase().as_str() {
        "auto" | "profile" | "user" | "default" => None,
        "zh" | "cn" | "chinese" | "zh-cn" => Some("zh-Hans".to_string()),
        "zh-tw" | "zh-hant" => Some("zh-Hant".to_string()),
        "en" => Some("en-US".to_string()),
        other => Some(other.to_string()),
    }
}

fn ocr_search_roi(step: &WorkflowStepInput, width: u32, height: u32) -> Option<RoiRect> {
    scaled_roi(step.roi, width, height).or_else(|| {
        let name = step
            .ocr_region
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| command_value(&step.command, "roi"))?;
        named_ocr_roi(name, width, height)
    })
}

fn named_ocr_roi(value: &str, width: u32, height: u32) -> Option<RoiRect> {
    if width == 0 || height == 0 {
        return None;
    }
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "auto" | "full" | "window" => None,
        "top" | "title" => Some(RoiRect {
            x: 0,
            y: 0,
            w: width,
            h: (height / 4).max(1),
        }),
        "bottom" => Some(RoiRect {
            x: 0,
            y: height.saturating_mul(3) / 4,
            w: width,
            h: (height / 4).max(1),
        }),
        "left" => Some(RoiRect {
            x: 0,
            y: 0,
            w: (width / 3).max(1),
            h: height,
        }),
        "right" => Some(RoiRect {
            x: width.saturating_mul(2) / 3,
            y: 0,
            w: (width / 3).max(1),
            h: height,
        }),
        "center" | "panel" => Some(centered_roi(width, height, 80, 80)),
        "dialog" => Some(centered_roi(width, height, 64, 64)),
        _ => None,
    }
}

fn centered_roi(width: u32, height: u32, width_percent: u32, height_percent: u32) -> RoiRect {
    let w = (width.saturating_mul(width_percent) / 100).max(1);
    let h = (height.saturating_mul(height_percent) / 100).max(1);
    RoiRect {
        x: width.saturating_sub(w) / 2,
        y: height.saturating_sub(h) / 2,
        w,
        h,
    }
}

fn crop_frame(frame: &RgbFrame, roi: Option<RoiRect>) -> Result<RgbFrame, String> {
    let Some(roi) = scaled_roi(roi, frame.width, frame.height) else {
        return Ok(frame.clone());
    };
    let pixels = u64::from(roi.w) * u64::from(roi.h);
    if pixels > MAX_OCR_PIXELS {
        return Err(format!("OCR ROI is too large: {}x{}", roi.w, roi.h));
    }
    let mut cropped = Vec::with_capacity((pixels * 3) as usize);
    for y in roi.y..roi.y + roi.h {
        let start = ((y * frame.width + roi.x) as usize) * 3;
        let end = start + roi.w as usize * 3;
        cropped.extend_from_slice(&frame.pixels[start..end]);
    }
    Ok(RgbFrame {
        width: roi.w,
        height: roi.h,
        pixels: cropped,
    })
}

fn matched_ocr_text(recognized: &str, expected_texts: &[String]) -> Option<String> {
    let recognized = normalize_ocr_text(recognized);
    if recognized.is_empty() {
        return None;
    }
    expected_texts
        .iter()
        .find(|expected| {
            let expected = normalize_ocr_text(expected);
            !expected.is_empty() && recognized.contains(&expected)
        })
        .cloned()
}

fn normalize_ocr_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect()
}

fn summarize_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary: String = compact.chars().take(max_chars).collect();
    if compact.chars().count() > max_chars {
        summary.push('…');
    }
    summary
}

fn roi_label(roi: Option<RoiRect>) -> String {
    roi.map(|value| format!("{},{},{}x{}", value.x, value.y, value.w, value.h))
        .unwrap_or_else(|| "full".to_string())
}

#[cfg(windows)]
fn recognize_ocr_text(frame: &RgbFrame, language: Option<&str>) -> Result<String, String> {
    use windows::{
        Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
    };

    if frame.width == 0 || frame.height == 0 {
        return Err("OCR frame is empty".to_string());
    }
    let pixels = u64::from(frame.width) * u64::from(frame.height);
    if pixels > MAX_OCR_PIXELS {
        return Err(format!(
            "OCR frame is too large: {}x{}",
            frame.width, frame.height
        ));
    }
    let max_dim = OcrEngine::MaxImageDimension().map_err(|err| err.to_string())?;
    if frame.width > max_dim || frame.height > max_dim {
        return Err(format!(
            "OCR frame exceeds Windows max dimension {max_dim}: {}x{}",
            frame.width, frame.height
        ));
    }
    let bgra = rgb_to_bgra(&frame.pixels);
    let buffer = bytes_to_ibuffer(&bgra)?;
    let width =
        i32::try_from(frame.width).map_err(|_| "OCR frame width is too large".to_string())?;
    let height =
        i32::try_from(frame.height).map_err(|_| "OCR frame height is too large".to_string())?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width,
        height,
        BitmapAlphaMode::Ignore,
    )
    .map_err(|err| err.to_string())?;
    let engine = create_ocr_engine(language)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?;
    result
        .Text()
        .map(|text| text.to_string_lossy())
        .map_err(|err| err.to_string())
}

#[cfg(windows)]
fn create_ocr_engine(language: Option<&str>) -> Result<windows::Media::Ocr::OcrEngine, String> {
    use windows::{core::HSTRING, Globalization::Language, Media::Ocr::OcrEngine};

    let Some(language) = language.filter(|value| !value.trim().is_empty()) else {
        return OcrEngine::TryCreateFromUserProfileLanguages().map_err(|err| err.to_string());
    };
    let language =
        Language::CreateLanguage(&HSTRING::from(language)).map_err(|err| err.to_string())?;
    let supported = OcrEngine::IsLanguageSupported(&language).map_err(|err| err.to_string())?;
    if !supported {
        return Err(format!(
            "OCR language {} is not installed or supported",
            language
                .LanguageTag()
                .map(|tag| tag.to_string_lossy())
                .unwrap_or_default()
        ));
    }
    OcrEngine::TryCreateFromLanguage(&language).map_err(|err| err.to_string())
}

#[cfg(windows)]
fn bytes_to_ibuffer(bytes: &[u8]) -> Result<windows::Storage::Streams::IBuffer, String> {
    use windows::Storage::Streams::DataWriter;

    let writer = DataWriter::new().map_err(|err| err.to_string())?;
    writer.WriteBytes(bytes).map_err(|err| err.to_string())?;
    writer.DetachBuffer().map_err(|err| err.to_string())
}

#[cfg(windows)]
fn rgb_to_bgra(rgb: &[u8]) -> Vec<u8> {
    let mut bgra = Vec::with_capacity(rgb.len() / 3 * 4);
    for px in rgb.chunks_exact(3) {
        bgra.extend_from_slice(&[px[2], px[1], px[0], 0xff]);
    }
    bgra
}

#[cfg(not(windows))]
fn recognize_ocr_text(_frame: &RgbFrame, _language: Option<&str>) -> Result<String, String> {
    Err("Windows OCR is only available on Windows".to_string())
}

fn step_result(
    hwnd: isize,
    step_type: &str,
    status: impl Into<String>,
    action: impl Into<String>,
    detail: impl Into<String>,
) -> StepDispatchResult {
    step_result_with_input(hwnd, step_type, status, action, detail, false, None)
}

fn step_result_with_input(
    hwnd: isize,
    step_type: &str,
    status: impl Into<String>,
    action: impl Into<String>,
    detail: impl Into<String>,
    input_sent: bool,
    score: Option<f32>,
) -> StepDispatchResult {
    StepDispatchResult {
        hwnd,
        step_type: step_type.to_string(),
        status: status.into(),
        action: action.into(),
        detail: detail.into(),
        input_sent,
        matched: score.is_some_and(|value| value >= 0.0),
        x: None,
        y: None,
        score,
    }
}

fn append_step_metadata(result: &mut StepDispatchResult, step: &WorkflowStepInput) {
    let mut parts = Vec::new();
    if !step.expect.trim().is_empty() {
        parts.push(format!("expect={}", step.expect.trim()));
    }
    if let Some(asset_id) = step
        .asset_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("assetId={}", asset_id.trim()));
    }
    if let Some(target_id) = step
        .target_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("targetId={}", target_id.trim()));
    }
    if let Some(asset_kind) = step
        .asset_kind
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("assetKind={}", asset_kind.trim()));
    }
    if let Some(target_kind) = step
        .target_kind
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("targetKind={}", target_kind.trim()));
    }
    if !step.target_texts.is_empty() {
        parts.push(format!("targetTexts={}", step.target_texts.len()));
    }
    if let Some(language) = step
        .ocr_language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("ocrLanguage={}", language.trim()));
    }
    if let Some(region) = step
        .ocr_region
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("ocrRegion={}", region.trim()));
    }
    if !parts.is_empty() {
        result.detail = format!("{}; {}", result.detail, parts.join("; "));
    }
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    values
        .into_iter()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

fn text_input_value(step: &WorkflowStepInput) -> Result<&str, String> {
    let text = first_non_empty([
        command_value(&step.command, "text").unwrap_or_default(),
        command_value(&step.command, "value").unwrap_or_default(),
        step.target.as_str(),
    ])
    .ok_or_else(|| "text_input step requires target text or command text=...".to_string())?;
    if text.chars().count() > MAX_TEXT_INPUT_CHARS {
        return Err(format!(
            "text_input is too long: maximum {MAX_TEXT_INPUT_CHARS} characters"
        ));
    }
    Ok(text)
}

fn command_value<'a>(command: &'a str, key: &str) -> Option<&'a str> {
    command.split([';', ',']).find_map(|part| {
        let (left, right) = part.split_once('=')?;
        left.trim()
            .eq_ignore_ascii_case(key)
            .then_some(right.trim())
            .filter(|value| !value.is_empty())
    })
}

fn template_data_url(step: &WorkflowStepInput) -> Option<&str> {
    first_non_empty([
        step.target_data_url.as_deref().unwrap_or_default(),
        step.asset_data_url.as_deref().unwrap_or_default(),
    ])
}

fn image_threshold(step: &WorkflowStepInput) -> Result<f32, String> {
    let Some(raw) = command_value(&step.command, "threshold") else {
        return Ok(DEFAULT_IMAGE_THRESHOLD);
    };
    let value = raw
        .parse::<f32>()
        .map_err(|_| format!("invalid image threshold: {raw}"))?;
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(format!(
            "image threshold must be finite and within 0..=1: {raw}"
        ));
    }
    Ok(value)
}

fn image_click_point(
    matched: &TemplateMatch,
    step: &WorkflowStepInput,
    frame_width: u32,
    frame_height: u32,
) -> Result<HwndPoint, String> {
    if frame_width == 0 || frame_height == 0 {
        return Err("target frame is empty".to_string());
    }
    let point = command_value(&step.command, "point").unwrap_or("center");
    let (base_x, base_y) = match point.trim().to_ascii_lowercase().as_str() {
        "" | "center" | "middle" => (
            matched.x as i64 + i64::from(matched.width / 2),
            matched.y as i64 + i64::from(matched.height / 2),
        ),
        "top-left" | "left-top" | "tl" => (matched.x as i64, matched.y as i64),
        "top-right" | "right-top" | "tr" => (
            matched.x as i64 + i64::from(matched.width.saturating_sub(1)),
            matched.y as i64,
        ),
        "bottom-left" | "left-bottom" | "bl" => (
            matched.x as i64,
            matched.y as i64 + i64::from(matched.height.saturating_sub(1)),
        ),
        "bottom-right" | "right-bottom" | "br" => (
            matched.x as i64 + i64::from(matched.width.saturating_sub(1)),
            matched.y as i64 + i64::from(matched.height.saturating_sub(1)),
        ),
        other => return Err(format!("unsupported image click point: {other}")),
    };
    if base_x < 0 || base_y < 0 || base_x > u32::MAX as i64 || base_y > u32::MAX as i64 {
        return Err(format!(
            "image click point is outside coordinate range: {base_x},{base_y}"
        ));
    }
    let point = point_with_command_offset(
        HwndPoint {
            x: base_x as u32,
            y: base_y as u32,
        },
        step,
    )?;
    if point.x >= frame_width || point.y >= frame_height {
        return Err(format!(
            "image click point {},{} is outside target frame {}x{}",
            point.x, point.y, frame_width, frame_height
        ));
    }
    Ok(point)
}

fn command_i32_value(command: &str, key: &str) -> Result<Option<i32>, String> {
    let Some(raw) = command_value(command, key) else {
        return Ok(None);
    };
    raw.parse::<i32>()
        .map(Some)
        .map_err(|_| format!("{key} must be an integer: {raw}"))
}

fn point_from_step_with_offset(step: &WorkflowStepInput) -> Result<Option<HwndPoint>, String> {
    point_from_step(step)
        .map(|point| point_with_command_offset(point, step))
        .transpose()
}

fn point_with_command_offset(
    point: HwndPoint,
    step: &WorkflowStepInput,
) -> Result<HwndPoint, String> {
    let offset_x = command_i32_value(&step.command, "offsetX")?.unwrap_or(0);
    let offset_y = command_i32_value(&step.command, "offsetY")?.unwrap_or(0);
    let x = i64::from(point.x) + i64::from(offset_x);
    let y = i64::from(point.y) + i64::from(offset_y);
    if x < 0 || y < 0 || x > u32::MAX as i64 || y > u32::MAX as i64 {
        return Err(format!("click point is outside coordinate range: {x},{y}"));
    }
    Ok(HwndPoint {
        x: x as u32,
        y: y as u32,
    })
}

fn point_from_step(step: &WorkflowStepInput) -> Option<HwndPoint> {
    parse_point(&step.target)
        .or_else(|| parse_point(&step.command))
        .or_else(|| step.roi.and_then(|roi| roi.center()))
}

fn parse_point(value: &str) -> Option<HwndPoint> {
    let mut x = None;
    let mut y = None;
    for part in value
        .split([',', ';', ' '])
        .filter(|part| !part.trim().is_empty())
    {
        let (key, raw) = part.split_once('=')?;
        match key.trim().to_ascii_lowercase().as_str() {
            "x" => x = raw.trim().parse::<u32>().ok(),
            "y" => y = raw.trim().parse::<u32>().ok(),
            _ => {}
        }
    }
    Some(HwndPoint { x: x?, y: y? })
}

impl RoiRect {
    fn center(self) -> Option<HwndPoint> {
        let x = self.x.checked_add(self.w / 2)?;
        let y = self.y.checked_add(self.h / 2)?;
        Some(HwndPoint { x, y })
    }
}

fn scaled_roi(roi: Option<RoiRect>, width: u32, height: u32) -> Option<RoiRect> {
    let roi = roi?;
    if roi.w == 0 || roi.h == 0 || width == 0 || height == 0 {
        return None;
    }
    let x = roi.x.min(width);
    let y = roi.y.min(height);
    let w = roi.w.min(width.saturating_sub(x));
    let h = roi.h.min(height.saturating_sub(y));
    (w > 0 && h > 0).then_some(RoiRect { x, y, w, h })
}

#[cfg(windows)]
fn read_clipboard_rgb_frame() -> Result<RgbFrame, String> {
    use std::{slice, thread, time::Duration};
    use windows::Win32::{
        Foundation::HGLOBAL,
        System::{
            DataExchange::{GetClipboardData, IsClipboardFormatAvailable, OpenClipboard},
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            Ole::{CF_DIB, CF_DIBV5},
        },
    };

    const ATTEMPTS: usize = 12;
    const RETRY_DELAY: Duration = Duration::from_millis(25);

    let mut last_error = None;
    for attempt in 0..ATTEMPTS {
        match unsafe { OpenClipboard(None) } {
            Ok(()) => {
                let _guard = ClipboardGuard;
                let format = if unsafe { IsClipboardFormatAvailable(u32::from(CF_DIBV5.0)) }.is_ok()
                {
                    u32::from(CF_DIBV5.0)
                } else if unsafe { IsClipboardFormatAvailable(u32::from(CF_DIB.0)) }.is_ok() {
                    u32::from(CF_DIB.0)
                } else {
                    return Err("剪贴板里没有图片；用截图工具复制后再按 Ctrl+V。".to_string());
                };
                let handle = unsafe { GetClipboardData(format) }
                    .map_err(|err| format!("cannot read clipboard image: {err}"))?;
                let hglobal = HGLOBAL(handle.0);
                let size = unsafe { GlobalSize(hglobal) };
                if size == 0 {
                    return Err("clipboard image data is empty".to_string());
                }
                let ptr = unsafe { GlobalLock(hglobal) };
                if ptr.is_null() {
                    return Err("cannot lock clipboard image data".to_string());
                }
                let bytes = unsafe { slice::from_raw_parts(ptr.cast::<u8>(), size) }.to_vec();
                unsafe {
                    let _ = GlobalUnlock(hglobal);
                }
                return dib_to_rgb_frame(&bytes);
            }
            Err(err) => {
                last_error = Some(err);
                if attempt + 1 < ATTEMPTS {
                    thread::sleep(RETRY_DELAY);
                }
            }
        }
    }

    Err(format!(
        "cannot open clipboard: {}",
        last_error
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(windows)]
struct ClipboardGuard;

#[cfg(windows)]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

#[cfg(not(windows))]
fn read_clipboard_rgb_frame() -> Result<RgbFrame, String> {
    Err("clipboard image import is only implemented on Windows".to_string())
}

fn dib_to_rgb_frame(dib: &[u8]) -> Result<RgbFrame, String> {
    let decoder = image::codecs::bmp::BmpDecoder::new_without_file_header(Cursor::new(dib))
        .map_err(|err| format!("cannot decode clipboard image: {err}"))?;
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|err| format!("cannot decode clipboard image: {err}"))?
        .to_rgb8();
    Ok(RgbFrame {
        width: image.width(),
        height: image.height(),
        pixels: image.into_raw(),
    })
}

fn load_image_data_url_rgb(data_url: &str) -> Result<RgbFrame, String> {
    let data_url = data_url.trim();
    if data_url.len() > MAX_TEMPLATE_DATA_URL_CHARS {
        return Err(format!(
            "template data URL is too large: {} chars",
            data_url.len()
        ));
    }
    let payload = if let Some((header, payload)) = data_url.split_once(',') {
        let header = header.to_ascii_lowercase();
        if !header.starts_with("data:image/") || !header.contains(";base64") {
            return Err("template asset must be a base64 image data URL".to_string());
        }
        payload
    } else {
        data_url
    };
    if payload.len() > MAX_TEMPLATE_DATA_URL_CHARS {
        return Err(format!(
            "template base64 payload is too large: {} chars",
            payload.len()
        ));
    }
    let bytes = general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|err| err.to_string())?;
    if bytes.len() > MAX_TEMPLATE_BYTES {
        return Err(format!(
            "template image is too large: {} bytes",
            bytes.len()
        ));
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|err| err.to_string())?
        .to_rgb8();
    let pixels = u64::from(image.width()) * u64::from(image.height());
    if image.width() == 0 || image.height() == 0 || pixels > MAX_TEMPLATE_PIXELS {
        return Err(format!(
            "template dimensions are out of bounds: {}x{}",
            image.width(),
            image.height()
        ));
    }
    Ok(RgbFrame {
        width: image.width(),
        height: image.height(),
        pixels: image.into_raw(),
    })
}

fn match_template(
    frame: &RgbFrame,
    template: &RgbFrame,
    search_roi: Option<RoiRect>,
) -> Result<TemplateMatch, String> {
    if template.width == 0 || template.height == 0 {
        return Err("template image is empty".to_string());
    }
    if template.width > frame.width || template.height > frame.height {
        return Err(format!(
            "template {}x{} is larger than frame {}x{}",
            template.width, template.height, frame.width, frame.height
        ));
    }
    let roi = search_roi.unwrap_or(RoiRect {
        x: 0,
        y: 0,
        w: frame.width,
        h: frame.height,
    });
    let search_right = roi.x.saturating_add(roi.w).min(frame.width);
    let search_bottom = roi.y.saturating_add(roi.h).min(frame.height);
    if search_right < roi.x.saturating_add(template.width)
        || search_bottom < roi.y.saturating_add(template.height)
    {
        return Err("search ROI is smaller than template".to_string());
    }
    let max_x = search_right - template.width;
    let max_y = search_bottom - template.height;

    let mut best = TemplateMatch {
        x: roi.x,
        y: roi.y,
        width: template.width,
        height: template.height,
        score: f32::MIN,
    };
    for y in roi.y..=max_y {
        for x in roi.x..=max_x {
            let score = template_score(frame, template, x, y);
            if score > best.score {
                best.x = x;
                best.y = y;
                best.score = score;
            }
        }
    }
    Ok(best)
}

fn template_score(frame: &RgbFrame, template: &RgbFrame, left: u32, top: u32) -> f32 {
    let mut diff: u64 = 0;
    for y in 0..template.height {
        let frame_row = ((top + y) * frame.width + left) as usize * 3;
        let template_row = (y * template.width) as usize * 3;
        for x in 0..template.width as usize {
            let frame_index = frame_row + x * 3;
            let template_index = template_row + x * 3;
            diff += (i16::from(frame.pixels[frame_index])
                - i16::from(template.pixels[template_index]))
            .unsigned_abs() as u64;
            diff += (i16::from(frame.pixels[frame_index + 1])
                - i16::from(template.pixels[template_index + 1]))
            .unsigned_abs() as u64;
            diff += (i16::from(frame.pixels[frame_index + 2])
                - i16::from(template.pixels[template_index + 2]))
            .unsigned_abs() as u64;
        }
    }
    let max_diff = template.width as f32 * template.height as f32 * 3.0 * 255.0;
    1.0 - (diff as f32 / max_diff)
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
            load_workflow_workspace,
            save_workflow_workspace,
            current_window_identity,
            execute_workflow_step,
            capture_window_preview,
            save_window_snapshot,
            import_preview_image,
            import_clipboard_image,
            load_builtin_target_templates
        ])
        .run(tauri::generate_context!())
        .expect("error while running shikong workflow app");
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_GAME_TITLE: &str = "梦幻西游：时空";

    fn fake_window() -> platform::AppWindow {
        platform::AppWindow {
            hwnd: 42,
            title: "梦幻西游：时空".to_string(),
            process_id: 1234,
            process_name: "MyGame_x64r".to_string(),
            left: 0,
            top: 0,
            width: 1280,
            height: 760,
            client_left: 8,
            client_top: 31,
            client_width: 1264,
            client_height: 720,
            elevated: Some(true),
            ordinal: 1,
            display: "梦幻西游：时空 #1".to_string(),
        }
    }

    fn expected_from_window(window: &platform::AppWindow) -> ExpectedWindowInput {
        ExpectedWindowInput {
            hwnd: Some(window.hwnd),
            title: Some(window.title.clone()),
            process_id: Some(window.process_id),
            process_name: Some(window.process_name.clone()),
            client_width: Some(window.client_width),
            client_height: Some(window.client_height),
            elevated: window.elevated,
        }
    }

    fn frame_delta_ratio(left: &RgbFrame, right: &RgbFrame) -> f64 {
        if left.width != right.width || left.height != right.height {
            return 1.0;
        }
        let compared = left.pixels.len().min(right.pixels.len());
        if compared == 0 {
            return 0.0;
        }
        let changed = left
            .pixels
            .iter()
            .zip(&right.pixels)
            .filter(|(a, b)| a.abs_diff(**b) > 12)
            .count();
        changed as f64 / compared as f64
    }

    fn live_windows_are_accessible(windows: &[platform::AppWindow]) -> bool {
        if windows.iter().any(|window| window.elevated == Some(true)) && !current_process_elevated()
        {
            eprintln!(
                "skip live background input test: at least one target window is elevated but the test process is not"
            );
            return false;
        }
        true
    }

    fn image_step(command: &str) -> WorkflowStepInput {
        WorkflowStepInput {
            step_type: "image_click".to_string(),
            target: String::new(),
            command: command.to_string(),
            expect: String::new(),
            target_id: None,
            target_kind: None,
            target_data_url: None,
            asset_id: None,
            asset_kind: None,
            asset_data_url: None,
            roi: None,
            target_texts: Vec::new(),
            ocr_language: None,
            ocr_region: None,
        }
    }

    #[test]
    fn workspace_json_write_replaces_file_and_keeps_backup() {
        let dir = env::temp_dir().join(format!(
            "mhxy-workspace-write-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.json");
        fs::write(&path, br#"{"schemaVersion":1}"#).unwrap();

        let backup_path = atomic_write_workspace_json(&path, br#"{"schemaVersion":2}"#).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"schemaVersion":2}"#);
        assert_eq!(backup_path, Some(path.with_extension("json.bak")));
        assert_eq!(
            fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            r#"{"schemaVersion":1}"#
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[ignore = "requires live game windows and sends background ALT+N messages"]
    fn live_background_hotkey_changes_two_game_windows() {
        if std::env::var("MHXY_LIVE_GAME_TEST").ok().as_deref() != Some("1") {
            eprintln!("set MHXY_LIVE_GAME_TEST=1 to run live background input test");
            return;
        }
        let windows = list_windows(LIVE_GAME_TITLE).expect("list live game windows");
        assert!(
            windows.len() >= 2,
            "expected at least two live game windows, got {}",
            windows.len()
        );
        if !live_windows_are_accessible(&windows) {
            return;
        }
        for window in windows.iter().take(2) {
            let before = capture_client_rgb(window.hwnd).expect("capture before hotkey");
            let step = WorkflowStepInput {
                step_type: "hotkey".to_string(),
                target: "ALT+N".to_string(),
                command: "mode=hwnd-key".to_string(),
                expect: "panel.open".to_string(),
                target_id: None,
                target_kind: None,
                target_data_url: None,
                asset_id: None,
                asset_kind: None,
                asset_data_url: None,
                roi: None,
                target_texts: Vec::new(),
                ocr_language: None,
                ocr_region: None,
            };
            let result =
                execute_workflow_step(window.hwnd, step, Some(expected_from_window(window)))
                    .expect("post live background hotkey");
            assert!(result.input_sent, "hotkey should report input_sent");
            std::thread::sleep(std::time::Duration::from_millis(900));
            let after = capture_client_rgb(window.hwnd).expect("capture after hotkey");
            let delta = frame_delta_ratio(&before, &after);
            assert!(
                delta > 0.001,
                "window {} did not visibly change after background ALT+N; delta={delta:.6}",
                window.hwnd
            );
        }
    }

    #[test]
    #[ignore = "requires live game windows and sends parallel background ALT+N messages"]
    fn live_parallel_background_hotkey_changes_two_game_windows() {
        if std::env::var("MHXY_LIVE_GAME_TEST").ok().as_deref() != Some("1") {
            eprintln!("set MHXY_LIVE_GAME_TEST=1 to run live parallel background input test");
            return;
        }
        let windows = list_windows(LIVE_GAME_TITLE).expect("list live game windows");
        assert!(
            windows.len() >= 2,
            "expected at least two live game windows, got {}",
            windows.len()
        );
        if !live_windows_are_accessible(&windows) {
            return;
        }
        let windows: Vec<_> = windows.into_iter().take(2).collect();
        let before_frames: Vec<_> = windows
            .iter()
            .map(|window| {
                (
                    window.hwnd,
                    capture_client_rgb(window.hwnd).expect("capture before parallel hotkey"),
                )
            })
            .collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(windows.len()));
        let handles: Vec<_> = windows
            .into_iter()
            .map(|window| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let step = WorkflowStepInput {
                        step_type: "hotkey".to_string(),
                        target: "ALT+N".to_string(),
                        command: "mode=hwnd-key".to_string(),
                        expect: "panel.open".to_string(),
                        target_id: None,
                        target_kind: None,
                        target_data_url: None,
                        asset_id: None,
                        asset_kind: None,
                        asset_data_url: None,
                        roi: None,
                        target_texts: Vec::new(),
                        ocr_language: None,
                        ocr_region: None,
                    };
                    barrier.wait();
                    let result = execute_workflow_step(
                        window.hwnd,
                        step,
                        Some(expected_from_window(&window)),
                    )?;
                    Ok::<_, String>((window.hwnd, result))
                })
            })
            .collect();
        let mut sent_hwnds = Vec::new();
        for handle in handles {
            let (hwnd, result) = handle
                .join()
                .expect("parallel hotkey thread panicked")
                .expect("parallel hotkey failed");
            assert!(
                result.input_sent,
                "hotkey should report input_sent for {hwnd}"
            );
            sent_hwnds.push(hwnd);
        }
        std::thread::sleep(std::time::Duration::from_millis(900));
        for (hwnd, before) in before_frames {
            assert!(sent_hwnds.contains(&hwnd));
            let after = capture_client_rgb(hwnd).expect("capture after parallel hotkey");
            let delta = frame_delta_ratio(&before, &after);
            assert!(
                delta > 0.001,
                "window {hwnd} did not visibly change after parallel background ALT+N; delta={delta:.6}",
            );
        }
    }

    fn text_input_step(target: &str, command: &str) -> WorkflowStepInput {
        WorkflowStepInput {
            step_type: "text_input".to_string(),
            target: target.to_string(),
            command: command.to_string(),
            expect: String::new(),
            target_id: None,
            target_kind: None,
            target_data_url: None,
            asset_id: None,
            asset_kind: None,
            asset_data_url: None,
            roi: None,
            target_texts: Vec::new(),
            ocr_language: None,
            ocr_region: None,
        }
    }

    #[test]
    fn accepts_matching_expected_window_identity() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("mygame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        assert!(compare_expected_window(&fake_window(), &expected).is_ok());
    }

    #[test]
    fn rejects_missing_expected_window_identity() {
        let error = validate_expected_window(42, None).unwrap_err();
        assert!(error.contains("expected window identity is required"));
    }

    #[test]
    fn rejects_missing_expected_window_hwnd() {
        let expected = ExpectedWindowInput {
            hwnd: None,
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = validate_expected_window_argument(42, &expected).unwrap_err();
        assert!(error.contains("must include hwnd"));
    }

    #[test]
    fn rejects_expected_window_hwnd_argument_mismatch() {
        let expected = ExpectedWindowInput {
            hwnd: Some(43),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = validate_expected_window_argument(42, &expected).unwrap_err();
        assert!(error.contains("hwnd argument 42"));
    }

    #[test]
    fn image_click_requires_identity_recheck_before_point_click() {
        let mut step = image_step("x=10;y=20;button=left");
        step.roi = Some(RoiRect {
            x: 10,
            y: 20,
            w: 4,
            h: 4,
        });
        let error = dispatch_image_step(42, &step, MouseDispatchMode::Click, None).unwrap_err();
        assert!(error.contains("expected window identity is required"));
    }

    #[test]
    fn image_double_click_requires_identity_recheck_before_point_click() {
        let mut step = image_step("x=10;y=20;button=left");
        step.step_type = "double_click".to_string();
        step.roi = Some(RoiRect {
            x: 10,
            y: 20,
            w: 4,
            h: 4,
        });
        let error =
            dispatch_image_step(42, &step, MouseDispatchMode::DoubleClick, None).unwrap_err();
        assert!(error.contains("expected window identity is required"));
    }

    #[test]
    fn double_click_mode_reports_distinct_actions() {
        assert_eq!(
            MouseDispatchMode::DoubleClick.click_action(),
            "double_click"
        );
        assert_eq!(
            MouseDispatchMode::DoubleClick.image_action(),
            "image_double_click"
        );
        assert_eq!(
            MouseDispatchMode::DoubleClick.roi_action(),
            "roi_double_click"
        );
    }

    #[test]
    fn double_click_requires_point_or_bound_target() {
        let step = WorkflowStepInput {
            step_type: "double_click".to_string(),
            target: String::new(),
            command: "button=left".to_string(),
            expect: String::new(),
            target_id: None,
            target_kind: None,
            target_data_url: None,
            asset_id: None,
            asset_kind: None,
            asset_data_url: None,
            roi: None,
            target_texts: Vec::new(),
            ocr_language: None,
            ocr_region: None,
        };
        let error = dispatch_click_step(42, &step, MouseDispatchMode::DoubleClick).unwrap_err();
        assert!(error.contains("double_click step requires target"));
    }

    #[test]
    fn rejects_changed_expected_window_identity() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(9999),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("pid changed"));
    }

    #[test]
    fn rejects_incomplete_expected_window_fields() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: None,
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("processName"));
    }

    #[test]
    fn rejects_non_target_window_title() {
        let mut expected = expected_from_window(&fake_window());
        expected.title = Some("另一个窗口".to_string());
        let error = validate_expected_window_argument(42, &expected).unwrap_err();
        assert!(error.contains("does not contain"));
    }

    #[test]
    fn allows_small_client_size_drift() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1262),
            client_height: Some(722),
            elevated: Some(true),
        };
        assert!(compare_expected_window(&fake_window(), &expected).is_ok());
    }

    #[test]
    fn rejects_large_client_size_drift() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1261),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("client width changed"));
    }

    #[test]
    fn rejects_title_mismatch() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空 - 另一个".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("title changed"));
    }

    #[test]
    fn rejects_process_name_mismatch() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("OtherProcess".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(true),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("process changed"));
    }

    #[test]
    fn rejects_elevation_mismatch() {
        let expected = ExpectedWindowInput {
            hwnd: Some(42),
            title: Some("梦幻西游：时空".to_string()),
            process_id: Some(1234),
            process_name: Some("MyGame_x64r".to_string()),
            client_width: Some(1264),
            client_height: Some(720),
            elevated: Some(false),
        };
        let error = compare_expected_window(&fake_window(), &expected).unwrap_err();
        assert!(error.contains("elevation changed"));
    }

    #[test]
    fn parses_bounded_image_threshold() {
        assert_eq!(
            image_threshold(&image_step("threshold=0.75")).unwrap(),
            0.75
        );
        assert_eq!(
            image_threshold(&image_step("button=left")).unwrap(),
            DEFAULT_IMAGE_THRESHOLD
        );
    }

    #[test]
    fn rejects_invalid_image_threshold() {
        for raw in [
            "threshold=-0.1",
            "threshold=1.01",
            "threshold=NaN",
            "threshold=inf",
        ] {
            assert!(image_threshold(&image_step(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn image_click_point_supports_corners_and_offsets() {
        let matched = TemplateMatch {
            x: 10,
            y: 20,
            width: 8,
            height: 6,
            score: 0.9,
        };
        let step = image_step("point=bottom-right; offsetX=-2; offsetY=3");
        let point = image_click_point(&matched, &step, 100, 100).unwrap();
        assert_eq!((point.x, point.y), (15, 28));
    }

    #[test]
    fn image_click_point_rejects_unknown_point() {
        let matched = TemplateMatch {
            x: 10,
            y: 20,
            width: 8,
            height: 6,
            score: 0.9,
        };
        let step = image_step("point=random");
        let error = image_click_point(&matched, &step, 100, 100).unwrap_err();
        assert!(error.contains("unsupported image click point"));
    }

    #[test]
    fn image_click_point_rejects_invalid_offset() {
        let matched = TemplateMatch {
            x: 10,
            y: 20,
            width: 8,
            height: 6,
            score: 0.9,
        };
        let step = image_step("offsetX=left");
        let error = image_click_point(&matched, &step, 100, 100).unwrap_err();
        assert!(error.contains("offsetX must be an integer"));
    }

    #[test]
    fn image_click_point_rejects_offset_outside_frame() {
        let matched = TemplateMatch {
            x: 10,
            y: 20,
            width: 8,
            height: 6,
            score: 0.9,
        };
        let step = image_step("point=bottom-right; offsetX=100");
        let error = image_click_point(&matched, &step, 100, 100).unwrap_err();
        assert!(error.contains("outside target frame"));
    }

    #[test]
    fn point_from_step_applies_offsets_to_direct_points() {
        let step = image_step("offsetX=-3; offsetY=4");
        let mut step = step;
        step.target = "x=20,y=30".to_string();
        let point = point_from_step_with_offset(&step).unwrap().unwrap();
        assert_eq!((point.x, point.y), (17, 34));
    }

    #[test]
    fn plain_point_parser_ignores_image_offsets() {
        let mut step = image_step("offsetX=-3; offsetY=4");
        step.target = "x=20,y=30".to_string();
        let point = point_from_step(&step).unwrap();
        assert_eq!((point.x, point.y), (20, 30));
    }

    #[test]
    fn point_from_step_rejects_negative_offset_outside_window() {
        let mut step = image_step("offsetX=-30");
        step.target = "x=20,y=30".to_string();
        let error = point_from_step_with_offset(&step).unwrap_err();
        assert!(error.contains("outside coordinate range"));
    }

    #[test]
    fn reads_text_input_from_command_before_target() {
        let step = text_input_step("target fallback", "mode=hwnd-char; text=hello");
        assert_eq!(text_input_value(&step).unwrap(), "hello");
    }

    #[test]
    fn loads_builtin_target_template_from_mapping() {
        let templates = load_builtin_target_templates(vec![
            "zonghe/jiahao.png".to_string(),
            "zonghe/jiahao.png".to_string(),
            "missing/template.png".to_string(),
        ])
        .unwrap();

        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].key, "zonghe/jiahao.png");
        assert!(templates[0]
            .replacement_path
            .ends_with("assets/resource/ShiKong/image/zonghe/jiahao.png"));
        assert!(templates[0].width > 0);
        assert!(templates[0].height > 0);
        assert!(templates[0].data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn reads_text_input_from_target_when_command_has_no_text() {
        let step = text_input_step("你好", "mode=hwnd-char");
        assert_eq!(text_input_value(&step).unwrap(), "你好");
    }

    #[test]
    fn rejects_empty_text_input_step() {
        let step = text_input_step("   ", "mode=hwnd-char");
        let error = text_input_value(&step).unwrap_err();
        assert!(error.contains("requires target text"));
    }

    #[test]
    fn rejects_overlong_text_input_step() {
        let step = text_input_step(&"a".repeat(MAX_TEXT_INPUT_CHARS + 1), "");
        let error = text_input_value(&step).unwrap_err();
        assert!(error.contains("maximum"));
    }

    #[test]
    fn collects_ocr_expected_texts_without_generic_markers() {
        let mut step = image_step("text=藏宝图; contains=should_not_duplicate");
        step.step_type = "ocr_assert".to_string();
        step.target = "藏宝图".to_string();
        step.expect = "text_found".to_string();
        step.target_texts = vec!["帮派福利".to_string(), "藏宝图".to_string()];
        assert_eq!(expected_ocr_texts(&step), vec!["帮派福利", "藏宝图"]);
    }

    #[test]
    fn normalizes_common_ocr_language_tags() {
        assert_eq!(
            ocr_language_tag(&image_step("lang=zh")),
            Some("zh-Hans".to_string())
        );
        assert_eq!(
            ocr_language_tag(&image_step("lang=en")),
            Some("en-US".to_string())
        );
        assert_eq!(ocr_language_tag(&image_step("lang=auto")), None);
    }

    #[test]
    fn matches_ocr_texts_ignoring_spacing_and_case() {
        let expected = vec!["Bang Pai 福利".to_string()];
        assert_eq!(
            matched_ocr_text("bangpai福利", &expected),
            Some("Bang Pai 福利".to_string())
        );
        assert!(matched_ocr_text("福利", &expected).is_none());
        assert!(matched_ocr_text("完全不同", &expected).is_none());
    }

    #[test]
    fn crops_rgb_frame_to_roi() {
        let frame = RgbFrame {
            width: 3,
            height: 2,
            pixels: vec![
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
            ],
        };
        let cropped = crop_frame(
            &frame,
            Some(RoiRect {
                x: 1,
                y: 0,
                w: 2,
                h: 2,
            }),
        )
        .unwrap();
        assert_eq!(cropped.width, 2);
        assert_eq!(cropped.height, 2);
        assert_eq!(
            cropped.pixels,
            vec![4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18]
        );
    }

    #[test]
    fn dib_to_rgb_frame_decodes_clipboard_bmp_rows() {
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&2i32.to_le_bytes());
        dib.extend_from_slice(&2i32.to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&24u16.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&16u32.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&[30, 20, 10, 60, 50, 40, 0, 0]);
        dib.extend_from_slice(&[90, 80, 70, 120, 110, 100, 0, 0]);

        let frame = dib_to_rgb_frame(&dib).unwrap();

        assert_eq!(frame.width, 2);
        assert_eq!(frame.height, 2);
        assert_eq!(
            frame.pixels,
            vec![70, 80, 90, 100, 110, 120, 10, 20, 30, 40, 50, 60]
        );
    }

    #[test]
    fn roi_center_uses_checked_addition() {
        assert_eq!(
            RoiRect {
                x: 10,
                y: 20,
                w: 8,
                h: 10
            }
            .center()
            .map(|point| (point.x, point.y)),
            Some((14, 25))
        );
        assert!(RoiRect {
            x: u32::MAX,
            y: 0,
            w: 2,
            h: 2
        }
        .center()
        .is_none());
    }

    #[test]
    fn scaled_roi_rejects_empty_clipped_regions() {
        assert!(scaled_roi(
            Some(RoiRect {
                x: 100,
                y: 0,
                w: 5,
                h: 5
            }),
            100,
            100
        )
        .is_none());
        assert!(scaled_roi(
            Some(RoiRect {
                x: 0,
                y: 100,
                w: 5,
                h: 5
            }),
            100,
            100
        )
        .is_none());
        assert_eq!(
            scaled_roi(
                Some(RoiRect {
                    x: 90,
                    y: 90,
                    w: 20,
                    h: 20
                }),
                100,
                100
            )
            .map(|roi| (roi.x, roi.y, roi.w, roi.h)),
            Some((90, 90, 10, 10))
        );
    }

    #[test]
    fn rejects_non_image_data_url_assets() {
        assert!(load_image_data_url_rgb("data:text/plain;base64,AA==").is_err());
    }

    #[test]
    fn prefers_target_data_url_for_templates() {
        let mut step = image_step("threshold=0.75");
        step.target_data_url = Some(" data:image/png;base64,target ".to_string());
        step.asset_data_url = Some("data:image/png;base64,asset".to_string());
        assert_eq!(
            template_data_url(&step),
            Some("data:image/png;base64,target")
        );
    }

    #[test]
    fn falls_back_to_legacy_asset_data_url_for_templates() {
        let mut step = image_step("threshold=0.75");
        step.target_data_url = Some(" ".to_string());
        step.asset_data_url = Some(" data:image/png;base64,asset ".to_string());
        assert_eq!(
            template_data_url(&step),
            Some("data:image/png;base64,asset")
        );
    }
}
