#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
mod single_instance;
mod tray;

use base64::{engine::general_purpose, Engine as _};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use platform::{
    capture_client_rgb, current_process_elevated, list_windows, post_hotkey, post_mouse_click,
    HwndPoint, RgbFrame,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    asset_id: Option<String>,
    #[serde(default)]
    asset_kind: Option<String>,
    #[serde(default)]
    asset_data_url: Option<String>,
    #[serde(default)]
    roi: Option<RoiRect>,
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
    fs::write(&path, text.as_bytes()).map_err(|err| format!("{}: {err}", path.display()))?;
    Ok(WorkflowWorkspaceSave {
        saved_path: path.display().to_string(),
        bytes: text.len(),
    })
}

#[tauri::command]
fn execute_workflow_step(
    hwnd: isize,
    step: WorkflowStepInput,
) -> Result<StepDispatchResult, String> {
    let step_type = step.step_type.trim().to_ascii_lowercase();
    let mut result = match step_type.as_str() {
        "hotkey" => dispatch_hotkey_step(hwnd, &step),
        "click" => dispatch_click_step(hwnd, &step),
        "image_click" => dispatch_image_step(hwnd, &step, true),
        "wait_image" | "detect_page" => dispatch_image_step(hwnd, &step, false),
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
        "delay" | "condition" | "retry_until" | "restore" => Ok(step_result(
            hwnd,
            &step.step_type,
            "planned",
            "no_input",
            "step is represented in the runner but has no direct backend input in this build",
        )),
        "ocr_assert" => Ok(step_result(
            hwnd,
            &step.step_type,
            "unsupported",
            "ocr",
            "OCR is modeled but not implemented in this build",
        )),
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

fn workflow_workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    dir.push("workspace.json");
    Ok(dir)
}

fn default_workflow_workspace() -> Value {
    json!({
        "schemaVersion": 2,
        "activeWorkflowId": null,
        "workflows": [],
        "assignments": {},
        "assets": [],
        "runHistory": []
    })
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

fn dispatch_click_step(
    hwnd: isize,
    step: &WorkflowStepInput,
) -> Result<StepDispatchResult, String> {
    let point = point_from_step(step).ok_or_else(|| {
        "click step requires target x=...,y=... or an ROI-bound asset".to_string()
    })?;
    let button = command_value(&step.command, "button").unwrap_or("left");
    let result = post_mouse_click(hwnd, point.clone(), button)?;
    let mut output = step_result_with_input(
        hwnd,
        &step.step_type,
        "sent",
        "click",
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
    execute_click: bool,
) -> Result<StepDispatchResult, String> {
    let button = command_value(&step.command, "button").unwrap_or("left");
    if let Some(data_url) = step
        .asset_data_url
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let frame = capture_client_rgb(hwnd)?;
        let template = load_image_data_url_rgb(data_url)?;
        let search_roi = scaled_roi(step.roi, frame.width, frame.height);
        let threshold = command_value(&step.command, "threshold")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.86);
        let matched = match_template(&frame, &template, search_roi)?;
        let center = HwndPoint {
            x: matched.x + matched.width / 2,
            y: matched.y + matched.height / 2,
        };
        let mut output = step_result_with_input(
            hwnd,
            &step.step_type,
            if matched.score >= threshold {
                if execute_click {
                    "sent"
                } else {
                    "matched"
                }
            } else {
                "below_threshold"
            },
            if execute_click {
                "image_click"
            } else {
                "image_match"
            },
            format!(
                "best score {:.3} at {},{} size {}x{} threshold {:.3}",
                matched.score, matched.x, matched.y, matched.width, matched.height, threshold
            ),
            false,
            Some(matched.score),
        );
        output.matched = matched.score >= threshold;
        output.x = Some(center.x);
        output.y = Some(center.y);
        if execute_click && matched.score >= threshold {
            let result = post_mouse_click(hwnd, center, button)?;
            output.input_sent = true;
            output.detail = format!("{}; {}", output.detail, result.detail);
        }
        return Ok(output);
    }

    if let Some(point) = point_from_step(step) {
        if execute_click {
            let result = post_mouse_click(hwnd, point.clone(), button)?;
            let mut output = step_result_with_input(
                hwnd,
                &step.step_type,
                "sent",
                "roi_click",
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
            "roi_match",
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
        if execute_click {
            "image_click"
        } else {
            "image_match"
        },
        "image step requires a pasted image asset or ROI target",
    ))
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
    if let Some(asset_kind) = step
        .asset_kind
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(format!("assetKind={}", asset_kind.trim()));
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

fn command_value<'a>(command: &'a str, key: &str) -> Option<&'a str> {
    command.split([';', ',']).find_map(|part| {
        let (left, right) = part.split_once('=')?;
        left.trim()
            .eq_ignore_ascii_case(key)
            .then_some(right.trim())
            .filter(|value| !value.is_empty())
    })
}

fn point_from_step(step: &WorkflowStepInput) -> Option<HwndPoint> {
    parse_point(&step.target)
        .or_else(|| parse_point(&step.command))
        .or_else(|| step.roi.map(|roi| roi.center()))
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
    fn center(self) -> HwndPoint {
        HwndPoint {
            x: self.x + self.w / 2,
            y: self.y + self.h / 2,
        }
    }
}

fn scaled_roi(roi: Option<RoiRect>, width: u32, height: u32) -> Option<RoiRect> {
    let roi = roi?;
    if roi.w == 0 || roi.h == 0 {
        return None;
    }
    Some(RoiRect {
        x: roi.x.min(width.saturating_sub(1)),
        y: roi.y.min(height.saturating_sub(1)),
        w: roi.w.min(width.saturating_sub(roi.x.min(width))),
        h: roi.h.min(height.saturating_sub(roi.y.min(height))),
    })
}

fn load_image_data_url_rgb(data_url: &str) -> Result<RgbFrame, String> {
    let payload = data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data_url);
    let bytes = general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|err| err.to_string())?;
    let image = image::load_from_memory(&bytes)
        .map_err(|err| err.to_string())?
        .to_rgb8();
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
            execute_workflow_step,
            capture_window_preview,
            save_window_snapshot,
            import_preview_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running shikong workflow app");
}
