#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod coords;
mod inventory;
mod ocr;
mod platform;
mod runtime;
mod vision;

use base64::{engine::general_purpose, Engine as _};
use coords::{CoordinateMapper, CoordinateMode};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use inventory::{
    build_pipeline_compat_report, build_template_coverage_report, load_inventory, MaaInventory,
    MaaTask, PipelineCompatReport, TemplateCaptureResult, TemplateCoverageReport,
};
use platform::{
    capture_client_rgb, current_process_elevated, focus_window_by_hwnd, list_windows,
    restart_current_process_as_admin, window_elevated_by_hwnd, window_identity_by_hwnd,
    CaptureSource, RgbFrame, WindowIdentity,
};
use runtime::{cancel_task, run_task, RunTaskRequest, TaskRunReport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use vision::merge_objects;

const MAA_SOURCE_DIR: &str = "Maa_MHXY_MG";
const ASPECT_4_3: f32 = 4.0 / 3.0;
const ASPECT_TOLERANCE: f32 = 0.08;

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
    saved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateReferencePreview {
    width: u32,
    height: u32,
    data_url: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegeStatus {
    current_process_elevated: bool,
    note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CropPlan {
    version: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    default_image_path: Option<String>,
    #[serde(default)]
    coordinate_space: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    capture_requirement: Option<String>,
    #[serde(default)]
    summary: Option<Value>,
    #[serde(default)]
    review_rules: Vec<String>,
    #[serde(default)]
    items: Vec<CropPlanItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CropPlanItem {
    #[serde(default)]
    template: String,
    #[serde(default)]
    template_id: Option<String>,
    #[serde(default)]
    image_path: Option<String>,
    #[serde(default)]
    roi: Option<[i32; 4]>,
    #[serde(default)]
    old_image_path: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    capture_scene: Option<String>,
    #[serde(default)]
    crop_target: Option<String>,
    #[serde(default)]
    acceptance_criteria: Option<String>,
    #[serde(default)]
    reject_if: Option<String>,
    #[serde(default)]
    recommended_command: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropPlanWriteResult {
    plan_path: String,
    item_count: usize,
    unreplaced_templates: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropPlanApplyReport {
    plan_path: String,
    applied: usize,
    skipped: usize,
    entries: Vec<CropPlanApplyEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropPlanApplyEntry {
    index: usize,
    template: String,
    status: String,
    detail: String,
    saved_path: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
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

#[derive(Debug, Clone)]
struct HeadlessAcceptanceOptions {
    title: String,
    hwnds: Vec<isize>,
    all_windows: bool,
    dry_run: bool,
    missing_only: bool,
    max_steps: Option<usize>,
    coordinate_mode: CoordinateMode,
    option_values_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessAcceptanceReport {
    version: u32,
    generated_at: u64,
    error: Option<String>,
    title: String,
    dry_run: bool,
    missing_only: bool,
    all_windows: bool,
    max_steps: Option<usize>,
    coordinate_mode: CoordinateMode,
    option_values_path: Option<String>,
    controller_elevated: bool,
    target_windows: usize,
    passed: bool,
    completed_interface_tasks: usize,
    required_interface_tasks: usize,
    summaries: Vec<HeadlessWindowAcceptanceSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessWindowAcceptanceSummary {
    hwnd: isize,
    title: String,
    display: String,
    target_elevated: Option<bool>,
    planned_tasks: usize,
    skipped_existing_tasks: usize,
    completed_tasks: usize,
    failed_task: Option<String>,
    stopped_reason: String,
    reports: Vec<TaskRunReport>,
}

#[derive(Debug, Clone, Default)]
struct HeadlessOptionValues {
    global: BTreeMap<String, Value>,
    per_task: BTreeMap<String, BTreeMap<String, Value>>,
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
            "接管台已以管理员权限运行，可以操作同级或低权限游戏窗口。".to_string()
        } else {
            "接管台不是管理员权限；如果游戏窗口是管理员权限，截图、置前和输入可能被 Windows 拦截。"
                .to_string()
        },
    }
}

#[tauri::command]
fn restart_as_admin() -> Result<(), String> {
    restart_current_process_as_admin()?;
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
fn focus_window(hwnd: isize) -> Result<(), String> {
    focus_window_by_hwnd(hwnd)
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
fn preview_client_roi(hwnd: isize, client_roi: [i32; 4]) -> Result<PreviewImage, String> {
    let frame = capture_client_rgb(hwnd)?;
    let cropped = crop_client_roi(&frame, client_roi)?;
    let png = encode_png(&cropped)?;
    Ok(PreviewImage {
        width: cropped.width,
        height: cropped.height,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ),
    })
}

#[tauri::command]
fn save_window_snapshot(hwnd: isize) -> Result<TemplateCaptureResult, String> {
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
    Ok(TemplateCaptureResult {
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
    let saved_path = if save_copy {
        let root = project_root()?;
        let dir = root
            .join("assets")
            .join("resource")
            .join("ShiKong")
            .join("captures");
        fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        let path = dir.join(format!("imported-{}.png", timestamp()));
        save_png(&frame, &path)?;
        Some(path.display().to_string())
    } else {
        None
    };
    let png = encode_png(&frame)?;
    Ok(ImportedPreviewImage {
        width: frame.width,
        height: frame.height,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ),
        saved_path,
    })
}

#[tauri::command]
fn old_template_preview(template_path: String) -> Result<TemplateReferencePreview, String> {
    let image_root = maa_source_root()?
        .join("assets")
        .join("resource")
        .join("base")
        .join("image");
    let relative = safe_template_path(&template_path)?;
    let path = image_root.join(relative);
    let frame = load_image_rgb(&path)?;
    let png = encode_png(&frame)?;
    Ok(TemplateReferencePreview {
        width: frame.width,
        height: frame.height,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ),
        path: path.display().to_string(),
    })
}

#[tauri::command]
fn load_maa_inventory() -> Result<MaaInventory, String> {
    load_inventory(&maa_source_root()?, Some(&project_root()?))
}

#[tauri::command]
fn template_coverage_report() -> Result<TemplateCoverageReport, String> {
    let inventory = load_inventory(&maa_source_root()?, Some(&project_root()?))?;
    Ok(build_template_coverage_report(&inventory))
}

#[tauri::command]
fn pipeline_compat_report() -> Result<PipelineCompatReport, String> {
    build_pipeline_compat_report(&maa_source_root()?)
}

#[tauri::command]
fn migration_status_report() -> Result<Value, String> {
    let path = project_root()?
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("reports")
        .join("latest-migration-status.json");
    let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

#[tauri::command]
fn live_acceptance_report() -> Result<Value, String> {
    let path = live_acceptance_report_path()?;
    let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

#[tauri::command]
fn acceptance_plan_report() -> Result<Value, String> {
    let path = acceptance_plan_report_path()?;
    let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

#[tauri::command]
fn refresh_live_acceptance_report() -> Result<Value, String> {
    let root = project_root()?;
    let script = root.join("scripts").join("live_acceptance.py");
    let report_path = live_acceptance_report_path()?;
    let before_modified = fs::metadata(&report_path)
        .and_then(|meta| meta.modified())
        .ok();
    let python = env::var("SHIKONG_PYTHON").unwrap_or_else(|_| "python".to_string());
    let output = Command::new(&python)
        .current_dir(&root)
        .arg(&script)
        .arg("--project-root")
        .arg(&root)
        .arg("--title")
        .arg("梦幻西游：时空")
        .output()
        .map_err(|err| format!("启动实机验收脚本失败 {python}: {err}"))?;
    let after_modified = fs::metadata(&report_path)
        .and_then(|meta| meta.modified())
        .ok();
    let refreshed = match (before_modified, after_modified) {
        (Some(before), Some(after)) => after > before,
        (None, Some(_)) => true,
        _ => false,
    };
    if !refreshed {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "实机验收报告未被本次刷新更新；status={}; stdout={}; stderr={}",
            output.status,
            stdout.trim(),
            stderr.trim()
        ));
    }
    match live_acceptance_report() {
        Ok(report) => Ok(report),
        Err(read_err) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            Err(format!(
                "实机验收脚本运行后无法读取报告：{read_err}; status={}; stdout={}; stderr={}",
                output.status,
                stdout.trim(),
                stderr.trim()
            ))
        }
    }
}

#[tauri::command]
fn refresh_acceptance_plan_report() -> Result<Value, String> {
    let root = project_root()?;
    let script = root.join("scripts").join("acceptance_plan.py");
    let report_path = acceptance_plan_report_path()?;
    let before_modified = fs::metadata(&report_path)
        .and_then(|meta| meta.modified())
        .ok();
    let python = env::var("SHIKONG_PYTHON").unwrap_or_else(|_| "python".to_string());
    let output = Command::new(&python)
        .current_dir(&root)
        .arg(&script)
        .arg("--project-root")
        .arg(&root)
        .output()
        .map_err(|err| format!("启动实机验收计划脚本失败 {python}: {err}"))?;
    let after_modified = fs::metadata(&report_path)
        .and_then(|meta| meta.modified())
        .ok();
    let refreshed = match (before_modified, after_modified) {
        (Some(before), Some(after)) => after > before,
        (None, Some(_)) => true,
        _ => false,
    };
    if !refreshed {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "实机验收计划未被本次刷新更新；status={}; stdout={}; stderr={}",
            output.status,
            stdout.trim(),
            stderr.trim()
        ));
    }
    match acceptance_plan_report() {
        Ok(report) => Ok(report),
        Err(read_err) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            Err(format!(
                "实机验收计划脚本运行后无法读取报告：{read_err}; status={}; stdout={}; stderr={}",
                output.status,
                stdout.trim(),
                stderr.trim()
            ))
        }
    }
}

#[tauri::command]
fn ocr_status() -> ocr::OcrAvailability {
    ocr::ocr_availability()
}

#[tauri::command]
fn run_maa_task(request: RunTaskRequest) -> Result<TaskRunReport, String> {
    execute_maa_task(request)
}

fn execute_maa_task(request: RunTaskRequest) -> Result<TaskRunReport, String> {
    let controller_elevated = current_process_elevated();
    let target_elevated = window_elevated_by_hwnd(request.hwnd)?;
    if !request.dry_run && !controller_elevated && matches!(target_elevated, Some(true)) {
        return Err("目标窗口是管理员权限；请先以管理员权限重启接管台后再执行真实任务".to_string());
    }
    let client_evidence = capture_client_rgb(request.hwnd).ok().map(|frame| {
        let aspect = client_aspect(frame.width, frame.height);
        (
            frame.width,
            frame.height,
            aspect,
            aspect.is_some_and(aspect_close_to_4x3),
            frame.capture_source,
        )
    });
    let mut report = run_task(request, &project_root()?, &maa_source_root()?)?;
    report.controller_elevated = Some(controller_elevated);
    report.target_elevated = target_elevated;
    if let Some((width, height, aspect, aspect_ok, capture_source)) = client_evidence {
        report.client_width = Some(width);
        report.client_height = Some(height);
        report.client_aspect = aspect;
        report.aspect_close_to_4x3 = Some(aspect_ok);
        report.client_evidence_capture_source = Some(capture_source);
        if !report.capture_sources.contains(&capture_source) {
            report.capture_sources.push(capture_source);
        }
        report.used_screen_region_fallback = report.used_screen_region_fallback
            || capture_source == CaptureSource::ScreenRegionFallback;
    }
    save_task_report(&report)?;
    Ok(report)
}

#[tauri::command]
fn cancel_maa_task(run_id: String) -> bool {
    cancel_task(&run_id)
}

#[tauri::command]
fn capture_template_roi(
    hwnd: isize,
    template_id: String,
    roi_override: Option<[i32; 4]>,
    coordinate_mode: Option<CoordinateMode>,
) -> Result<TemplateCaptureResult, String> {
    let project = project_root()?;
    let source = maa_source_root()?;
    let inventory = load_inventory(&source, Some(&project))?;
    let template = inventory
        .templates
        .iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| format!("template id not found: {template_id}"))?;
    let frame = capture_client_rgb(hwnd)?;
    let source_frame = (frame.width, frame.height);
    let source_roi = roi_override.or(template.roi);
    let cropped = if let Some(roi) = source_roi {
        crop_mapped_roi(&frame, roi, coordinate_mode.unwrap_or_default())?
    } else {
        frame
    };
    let save_path = project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("image")
        .join(
            template
                .template
                .replace('/', &std::path::MAIN_SEPARATOR.to_string()),
        );
    if let Some(parent) = save_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    save_png(&cropped, &save_path)?;
    inventory::record_mapping(
        &project,
        template,
        source_roi,
        "baseline",
        Some(&format!("{:?}", coordinate_mode.unwrap_or_default())),
        &save_path,
        cropped.width,
        cropped.height,
        Some(source_frame),
    )?;
    Ok(TemplateCaptureResult {
        saved_path: save_path.display().to_string(),
        width: cropped.width,
        height: cropped.height,
    })
}

#[tauri::command]
fn capture_template_client_roi(
    hwnd: isize,
    template_id: String,
    client_roi: [i32; 4],
) -> Result<TemplateCaptureResult, String> {
    let project = project_root()?;
    let source = maa_source_root()?;
    let inventory = load_inventory(&source, Some(&project))?;
    let template = inventory
        .templates
        .iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| format!("template id not found: {template_id}"))?;
    let frame = capture_client_rgb(hwnd)?;
    let cropped = crop_client_roi(&frame, client_roi)?;
    let save_path = template_save_path(&project, &template.template);
    if let Some(parent) = save_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    save_png(&cropped, &save_path)?;
    inventory::record_mapping(
        &project,
        template,
        Some(client_roi),
        "client",
        None,
        &save_path,
        cropped.width,
        cropped.height,
        Some((frame.width, frame.height)),
    )?;
    Ok(TemplateCaptureResult {
        saved_path: save_path.display().to_string(),
        width: cropped.width,
        height: cropped.height,
    })
}

#[tauri::command]
fn capture_template_image_roi(
    image_path: String,
    template_id: String,
    image_roi: [i32; 4],
) -> Result<TemplateCaptureResult, String> {
    let project = project_root()?;
    let source = maa_source_root()?;
    let inventory = load_inventory(&source, Some(&project))?;
    let template = inventory
        .templates
        .iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| format!("template id not found: {template_id}"))?;
    let frame = load_image_rgb(Path::new(&image_path))?;
    let cropped = crop_client_roi(&frame, image_roi)?;
    let save_path = template_save_path(&project, &template.template);
    if let Some(parent) = save_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    save_png(&cropped, &save_path)?;
    inventory::record_mapping(
        &project,
        template,
        Some(image_roi),
        "image",
        None,
        &save_path,
        cropped.width,
        cropped.height,
        Some((frame.width, frame.height)),
    )?;
    Ok(TemplateCaptureResult {
        saved_path: save_path.display().to_string(),
        width: cropped.width,
        height: cropped.height,
    })
}

#[tauri::command]
fn write_crop_plan(
    plan_name: Option<String>,
    image_path: Option<String>,
    only_unreplaced: bool,
    limit: Option<usize>,
) -> Result<CropPlanWriteResult, String> {
    let project = project_root()?;
    let inventory = load_inventory(&maa_source_root()?, Some(&project))?;
    let report = build_template_coverage_report(&inventory);
    let max_items = limit.unwrap_or(usize::MAX);
    let mut items = Vec::new();
    for template in &report.templates {
        if only_unreplaced && template.replaced {
            continue;
        }
        if items.len() >= max_items {
            break;
        }
        let note = format!(
            "refs={}, priority={}, tasks={}",
            template.total_refs,
            template.priority,
            template.tasks.join(" | ")
        );
        items.push(CropPlanItem {
            template: template.template.clone(),
            template_id: None,
            image_path: image_path.clone().filter(|value| !value.trim().is_empty()),
            roi: None,
            old_image_path: None,
            category: None,
            capture_scene: None,
            crop_target: None,
            acceptance_criteria: None,
            reject_if: None,
            recommended_command: None,
            note: Some(note),
        });
    }

    let name = plan_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unreplaced-templates");
    let mut file_part = sanitize_file_part(name);
    if file_part.is_empty() || file_part.chars().all(|ch| ch == '_') {
        file_part = "crop-plan".to_string();
    }
    let dir = project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("crop_plans");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let plan_path = dir.join(format!("{}-{}.json", file_part, timestamp()));
    let plan = CropPlan {
        version: 1,
        name: Some(name.to_string()),
        default_image_path: image_path.filter(|value| !value.trim().is_empty()),
        coordinate_space: Some("image".to_string()),
        created_at: Some(timestamp()),
        capture_requirement: None,
        summary: None,
        review_rules: Vec::new(),
        items,
    };
    let text = serde_json::to_string_pretty(&plan).map_err(|err| err.to_string())?;
    fs::write(&plan_path, text).map_err(|err| err.to_string())?;
    Ok(CropPlanWriteResult {
        plan_path: plan_path.display().to_string(),
        item_count: plan.items.len(),
        unreplaced_templates: report.unreplaced_templates,
    })
}

#[tauri::command]
fn write_runtime_missing_crop_plan(
    plan_name: Option<String>,
    image_path: Option<String>,
    limit: Option<usize>,
) -> Result<CropPlanWriteResult, String> {
    let project = project_root()?;
    let status_path = project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("reports")
        .join("latest-migration-status.json");
    let text = fs::read_to_string(&status_path)
        .map_err(|err| format!("{}: {err}", status_path.display()))?;
    let status: Value =
        serde_json::from_str(&text).map_err(|err| format!("{}: {err}", status_path.display()))?;
    let rows = status
        .get("templates")
        .and_then(Value::as_array)
        .ok_or_else(|| "latest-migration-status.json missing templates array".to_string())?;
    let max_items = limit.unwrap_or(usize::MAX);
    let default_image = image_path.clone().filter(|value| !value.trim().is_empty());
    let mut items = Vec::new();
    let mut runtime_missing = 0usize;
    for row in rows {
        if row
            .get("runtimeCovered")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        runtime_missing += 1;
        if items.len() >= max_items {
            continue;
        }
        let template = row
            .get("template")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if template.is_empty() {
            continue;
        }
        let guidance = runtime_template_guidance(template, row);
        let old_image_path = maa_old_image_path(&project, template);
        let note = runtime_missing_note(row, &project, &guidance);
        items.push(CropPlanItem {
            template: template.to_string(),
            template_id: None,
            image_path: default_image.clone(),
            roi: None,
            old_image_path: Some(old_image_path.display().to_string()),
            category: Some(guidance.category.to_string()),
            capture_scene: Some(guidance.capture_scene.to_string()),
            crop_target: Some(guidance.crop_target.to_string()),
            acceptance_criteria: Some(guidance.acceptance_criteria.to_string()),
            reject_if: Some(guidance.reject_if.to_string()),
            recommended_command: Some(guidance.recommended_command.to_string()),
            note: Some(note),
        });
    }

    let name = plan_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("runtime-missing-templates");
    let mut file_part = sanitize_file_part(name);
    if file_part.is_empty() || file_part.chars().all(|ch| ch == '_') {
        file_part = "runtime-missing".to_string();
    }
    let dir = project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("crop_plans");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let plan_path = dir.join(format!("{}-{}.json", file_part, timestamp()));
    let plan = CropPlan {
        version: 1,
        name: Some(name.to_string()),
        default_image_path: default_image,
        coordinate_space: Some("image".to_string()),
        created_at: Some(timestamp()),
        capture_requirement: runtime_capture_requirement(&status),
        summary: Some(runtime_plan_summary(&items)),
        review_rules: vec![
            "Only apply crops from real 梦幻西游：时空 screenshots, not low-score visual lookalikes.".to_string(),
            "For inventory icons, crop the item icon from the bag/material grid; avoid menu buttons, panel borders, quantity text, and unrelated skill/activity icons.".to_string(),
            "For wujian scene/NPC/floor templates, crop the actual in-scene target state; activity-list candidates are not valid replacements.".to_string(),
            "After applying crops, run validate_mapped_templates.py and npm run status:migration before treating a template as covered.".to_string(),
        ],
        items,
    };
    let text = serde_json::to_string_pretty(&plan).map_err(|err| err.to_string())?;
    fs::write(&plan_path, text).map_err(|err| err.to_string())?;
    Ok(CropPlanWriteResult {
        plan_path: plan_path.display().to_string(),
        item_count: plan.items.len(),
        unreplaced_templates: runtime_missing,
    })
}

#[tauri::command]
fn apply_crop_plan(plan_path: String) -> Result<CropPlanApplyReport, String> {
    let project = project_root()?;
    let source = maa_source_root()?;
    let resolved_plan_path = resolve_project_path(&project, &plan_path);
    let text = fs::read_to_string(&resolved_plan_path)
        .map_err(|err| format!("{}: {err}", resolved_plan_path.display()))?;
    let plan: CropPlan = serde_json::from_str(&text)
        .map_err(|err| format!("{}: {err}", resolved_plan_path.display()))?;
    let inventory = load_inventory(&source, Some(&project))?;
    let mut report = CropPlanApplyReport {
        plan_path: resolved_plan_path.display().to_string(),
        applied: 0,
        skipped: 0,
        entries: Vec::new(),
    };

    for (index, item) in plan.items.iter().enumerate() {
        let template_label = if item.template.is_empty() {
            item.template_id.clone().unwrap_or_default()
        } else {
            item.template.clone()
        };
        let mut entry = CropPlanApplyEntry {
            index: index + 1,
            template: template_label.clone(),
            status: "skipped".to_string(),
            detail: String::new(),
            saved_path: None,
            width: None,
            height: None,
        };

        let Some(roi) = item.roi else {
            entry.detail = "missing roi".to_string();
            report.skipped += 1;
            report.entries.push(entry);
            continue;
        };
        let Some(image_path) = item
            .image_path
            .as_ref()
            .or(plan.default_image_path.as_ref())
        else {
            entry.detail = "missing imagePath and defaultImagePath".to_string();
            report.skipped += 1;
            report.entries.push(entry);
            continue;
        };
        let Some(template) = find_plan_template(&inventory, item) else {
            entry.detail = "template not found in Maa inventory".to_string();
            report.skipped += 1;
            report.entries.push(entry);
            continue;
        };

        let resolved_image_path = resolve_project_path(&project, image_path);
        let result = load_image_rgb(&resolved_image_path).and_then(|frame| {
            let source_frame = (frame.width, frame.height);
            crop_client_roi(&frame, roi).and_then(|cropped| {
                let save_path = template_save_path(&project, &template.template);
                if let Some(parent) = save_path.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                save_png(&cropped, &save_path)?;
                inventory::record_mapping(
                    &project,
                    template,
                    Some(roi),
                    "imagePlan",
                    plan.coordinate_space.as_deref(),
                    &save_path,
                    cropped.width,
                    cropped.height,
                    Some(source_frame),
                )?;
                Ok((save_path, cropped.width, cropped.height))
            })
        });

        match result {
            Ok((save_path, width, height)) => {
                entry.status = "applied".to_string();
                entry.detail = format!("cropped roi={},{},{},{}", roi[0], roi[1], roi[2], roi[3]);
                entry.saved_path = Some(save_path.display().to_string());
                entry.width = Some(width);
                entry.height = Some(height);
                report.applied += 1;
            }
            Err(error) => {
                entry.detail = error;
                report.skipped += 1;
            }
        }
        report.entries.push(entry);
    }

    Ok(report)
}

fn project_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve MHXY-ShiKong-Control project root".to_string())
}

fn live_acceptance_report_path() -> Result<PathBuf, String> {
    Ok(project_root()?
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("reports")
        .join("latest-live-acceptance.json"))
}

fn acceptance_plan_report_path() -> Result<PathBuf, String> {
    Ok(project_root()?
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("reports")
        .join("latest-acceptance-plan.json"))
}

fn maa_source_root() -> Result<PathBuf, String> {
    let project = project_root()?;
    let common = project
        .parent()
        .ok_or_else(|| "failed to resolve COMMON workspace root".to_string())?;
    let source = common.join(MAA_SOURCE_DIR);
    if source.join("assets").join("interface.json").exists() {
        Ok(source)
    } else {
        Err(format!(
            "Maa source repo not found next to project: {}",
            source.display()
        ))
    }
}

fn crop_mapped_roi(
    frame: &RgbFrame,
    roi: [i32; 4],
    coordinate_mode: CoordinateMode,
) -> Result<RgbFrame, String> {
    let mapper = CoordinateMapper::new(frame.width, frame.height, coordinate_mode);
    let rect = mapper.rect(roi);
    let Some(rect) = mapper.clamp_rect(rect) else {
        return Err(format!(
            "scaled ROI is outside captured frame: roi={roi:?}, frame={}x{}",
            frame.width, frame.height
        ));
    };
    let left = rect.x as u32;
    let top = rect.y as u32;
    let out_width = rect.width as u32;
    let out_height = rect.height as u32;
    let bottom = top + out_height;
    let mut pixels = Vec::with_capacity(out_width as usize * out_height as usize * 3);
    for y in top..bottom {
        let start = ((y * frame.width + left) * 3) as usize;
        let end = start + out_width as usize * 3;
        pixels.extend_from_slice(&frame.pixels[start..end]);
    }
    Ok(RgbFrame {
        width: out_width,
        height: out_height,
        pixels,
        capture_source: frame.capture_source,
    })
}

fn crop_client_roi(frame: &RgbFrame, roi: [i32; 4]) -> Result<RgbFrame, String> {
    let left = roi[0].max(0).min(frame.width as i32);
    let top = roi[1].max(0).min(frame.height as i32);
    let right = roi[0]
        .saturating_add(roi[2].max(1))
        .max(0)
        .min(frame.width as i32);
    let bottom = roi[1]
        .saturating_add(roi[3].max(1))
        .max(0)
        .min(frame.height as i32);
    if right <= left || bottom <= top {
        return Err(format!(
            "client ROI is outside captured frame: roi={roi:?}, frame={}x{}",
            frame.width, frame.height
        ));
    }
    let out_width = (right - left) as u32;
    let out_height = (bottom - top) as u32;
    let mut pixels = Vec::with_capacity(out_width as usize * out_height as usize * 3);
    for y in top as u32..bottom as u32 {
        let start = ((y * frame.width + left as u32) * 3) as usize;
        let end = start + out_width as usize * 3;
        pixels.extend_from_slice(&frame.pixels[start..end]);
    }
    Ok(RgbFrame {
        width: out_width,
        height: out_height,
        pixels,
        capture_source: frame.capture_source,
    })
}

fn template_save_path(project: &Path, template: &str) -> PathBuf {
    project
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("image")
        .join(template.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
}

fn resolve_project_path(project: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        path
    } else {
        project.join(path)
    }
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
            "客户端工作目录不存在：{}",
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
        working_dir: working_dir_path.map(|path| path.display().to_string()),
        working_dir_exists,
        config_path: game_launch_config_path(project).display().to_string(),
        example_path: game_launch_example_path(project).display().to_string(),
        message,
    }
}

fn maybe_run_headless_acceptance_cli() -> Option<i32> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let options = match parse_headless_acceptance_options(&args) {
        Ok(Some(options)) => options,
        Ok(None) => return None,
        Err(err) => {
            eprintln!("{err}");
            return Some(2);
        }
    };
    match run_headless_acceptance(options.clone()) {
        Ok(report) => {
            match serde_json::to_string_pretty(&report) {
                Ok(text) => println!("{text}"),
                Err(err) => eprintln!("failed to render headless acceptance report: {err}"),
            }
            if report.passed {
                Some(0)
            } else {
                Some(2)
            }
        }
        Err(err) => {
            if let Err(save_err) = save_headless_acceptance_failure_report(&options, &err) {
                eprintln!("failed to save headless acceptance failure report: {save_err}");
            }
            eprintln!("{err}");
            Some(2)
        }
    }
}

fn parse_headless_acceptance_options(
    args: &[String],
) -> Result<Option<HeadlessAcceptanceOptions>, String> {
    if !args.iter().any(|arg| arg == "--headless-acceptance") {
        return Ok(None);
    }
    let mut options = HeadlessAcceptanceOptions {
        title: "梦幻西游：时空".to_string(),
        hwnds: Vec::new(),
        all_windows: false,
        dry_run: false,
        missing_only: false,
        max_steps: None,
        coordinate_mode: CoordinateMode::default(),
        option_values_path: None,
    };
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--headless-acceptance" => {}
            "--title" => {
                index += 1;
                options.title = args
                    .get(index)
                    .ok_or_else(|| "--title requires a value".to_string())?
                    .clone();
            }
            "--hwnd" => {
                index += 1;
                append_hwnd_values(
                    &mut options.hwnds,
                    args.get(index)
                        .ok_or_else(|| "--hwnd requires a value".to_string())?,
                )?;
            }
            "--all-windows" => options.all_windows = true,
            "--dry-run" => options.dry_run = true,
            "--missing-only" => options.missing_only = true,
            "--max-steps" => {
                index += 1;
                options.max_steps = Some(parse_usize_arg(
                    "--max-steps",
                    args.get(index)
                        .ok_or_else(|| "--max-steps requires a value".to_string())?,
                )?);
            }
            "--coordinate-mode" => {
                index += 1;
                options.coordinate_mode = parse_coordinate_mode_arg(
                    args.get(index)
                        .ok_or_else(|| "--coordinate-mode requires a value".to_string())?,
                )?;
            }
            "--option-values" => {
                index += 1;
                options.option_values_path = Some(
                    args.get(index)
                        .ok_or_else(|| "--option-values requires a value".to_string())?
                        .clone(),
                );
            }
            _ if arg.starts_with("--title=") => {
                options.title = arg["--title=".len()..].to_string();
            }
            _ if arg.starts_with("--hwnd=") => {
                append_hwnd_values(&mut options.hwnds, &arg["--hwnd=".len()..])?;
            }
            _ if arg.starts_with("--max-steps=") => {
                options.max_steps = Some(parse_usize_arg(
                    "--max-steps",
                    &arg["--max-steps=".len()..],
                )?);
            }
            _ if arg.starts_with("--coordinate-mode=") => {
                options.coordinate_mode =
                    parse_coordinate_mode_arg(&arg["--coordinate-mode=".len()..])?;
            }
            _ if arg.starts_with("--option-values=") => {
                options.option_values_path = Some(arg["--option-values=".len()..].to_string());
            }
            _ => return Err(format!("unknown headless acceptance argument: {arg}")),
        }
        index += 1;
    }
    if options.hwnds.len() > 1 {
        options.all_windows = true;
    }
    Ok(Some(options))
}

fn append_hwnd_values(target: &mut Vec<isize>, value: &str) -> Result<(), String> {
    for part in value.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let hwnd = trimmed
            .parse::<isize>()
            .map_err(|err| format!("invalid --hwnd value {trimmed}: {err}"))?;
        target.push(hwnd);
    }
    Ok(())
}

fn parse_usize_arg(name: &str, value: &str) -> Result<usize, String> {
    let parsed = value
        .trim()
        .parse::<usize>()
        .map_err(|err| format!("invalid {name} value {value}: {err}"))?;
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
    }
    Ok(parsed)
}

fn parse_coordinate_mode_arg(value: &str) -> Result<CoordinateMode, String> {
    match value.trim() {
        "cropCenter4x3" | "CropCenter4x3" | "4x3" => Ok(CoordinateMode::CropCenter4x3),
        "stretch1280x720" | "Stretch1280x720" | "stretch" => Ok(CoordinateMode::Stretch1280x720),
        other => Err(format!(
            "unknown coordinate mode {other}; expected cropCenter4x3 or stretch1280x720"
        )),
    }
}

fn run_headless_acceptance(
    options: HeadlessAcceptanceOptions,
) -> Result<HeadlessAcceptanceReport, String> {
    let project = project_root()?;
    let maa = maa_source_root()?;
    let inventory = load_inventory(&maa, Some(&project))?;
    let targets = resolve_headless_targets(&options)?;
    if targets.is_empty() {
        return Err(format!(
            "未找到标题包含“{}”的梦幻西游：时空窗口",
            options.title
        ));
    }
    let option_values =
        load_headless_option_values(&project, options.option_values_path.as_deref())?;
    let tasks = acceptance_ordered_tasks(&inventory.tasks);
    let option_definitions = inventory.option_definitions.clone();
    let summaries = thread::scope(|scope| {
        let mut handles = Vec::new();
        for target in targets {
            let tasks = tasks.clone();
            let option_definitions = option_definitions.clone();
            let option_values = option_values.clone();
            let options = options.clone();
            let project = project.clone();
            handles.push(scope.spawn(move || {
                run_headless_acceptance_for_window(
                    target,
                    tasks,
                    option_definitions,
                    option_values,
                    options,
                    project,
                )
            }));
        }
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "headless acceptance worker panicked".to_string())?
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    let required = inventory.tasks.len();
    let require_all_targets = options.all_windows || options.hwnds.len() > 1;
    let completed = if require_all_targets {
        summaries
            .iter()
            .map(|summary| summary.completed_tasks)
            .min()
            .unwrap_or_default()
    } else {
        summaries
            .iter()
            .map(|summary| summary.completed_tasks)
            .max()
            .unwrap_or_default()
    };
    let passed = required > 0
        && !summaries.is_empty()
        && if require_all_targets {
            summaries
                .iter()
                .all(|summary| summary.completed_tasks >= required && summary.failed_task.is_none())
        } else {
            summaries
                .iter()
                .any(|summary| summary.completed_tasks >= required && summary.failed_task.is_none())
        };
    let report = HeadlessAcceptanceReport {
        version: 1,
        generated_at: timestamp(),
        error: None,
        title: options.title,
        dry_run: options.dry_run,
        missing_only: options.missing_only,
        all_windows: options.all_windows,
        max_steps: options.max_steps,
        coordinate_mode: options.coordinate_mode,
        option_values_path: options.option_values_path,
        controller_elevated: current_process_elevated(),
        target_windows: summaries.len(),
        passed,
        completed_interface_tasks: completed,
        required_interface_tasks: required,
        summaries,
    };
    save_headless_acceptance_report(&report)?;
    Ok(report)
}

fn save_headless_acceptance_failure_report(
    options: &HeadlessAcceptanceOptions,
    err: &str,
) -> Result<(), String> {
    let report = HeadlessAcceptanceReport {
        version: 1,
        generated_at: timestamp(),
        error: Some(err.to_string()),
        title: options.title.clone(),
        dry_run: options.dry_run,
        missing_only: options.missing_only,
        all_windows: options.all_windows,
        max_steps: options.max_steps,
        coordinate_mode: options.coordinate_mode,
        option_values_path: options.option_values_path.clone(),
        controller_elevated: current_process_elevated(),
        target_windows: 0,
        passed: false,
        completed_interface_tasks: 0,
        required_interface_tasks: 0,
        summaries: Vec::new(),
    };
    save_headless_acceptance_report(&report)
}

fn resolve_headless_targets(
    options: &HeadlessAcceptanceOptions,
) -> Result<Vec<platform::AppWindow>, String> {
    if options.hwnds.is_empty() {
        let windows = list_windows(&options.title)?;
        if options.all_windows {
            return Ok(windows);
        }
        return Ok(windows.into_iter().take(1).collect());
    }
    let requested = options.hwnds.iter().copied().collect::<BTreeSet<_>>();
    let windows = list_windows("")?;
    let mut found = Vec::new();
    for window in windows {
        if requested.contains(&window.hwnd) {
            found.push(window);
        }
    }
    let found_hwnds = found
        .iter()
        .map(|window| window.hwnd)
        .collect::<BTreeSet<_>>();
    let missing = requested
        .difference(&found_hwnds)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!("指定 hwnd 未找到或不可见：{}", missing.join(", ")));
    }
    Ok(found)
}

fn acceptance_ordered_tasks(tasks: &[MaaTask]) -> Vec<MaaTask> {
    let mut ordered = tasks
        .iter()
        .filter(|task| !is_stop_app_task(task))
        .cloned()
        .collect::<Vec<_>>();
    ordered.extend(tasks.iter().filter(|task| is_stop_app_task(task)).cloned());
    ordered
}

fn is_stop_app_task(task: &MaaTask) -> bool {
    task.entry == "stop" || task.name == "停止游戏"
}

fn load_headless_option_values(
    project: &Path,
    path: Option<&str>,
) -> Result<HeadlessOptionValues, String> {
    let Some(path) = path.filter(|value| !value.trim().is_empty()) else {
        return Ok(HeadlessOptionValues::default());
    };
    let path = resolve_project_path(project, path);
    let text = fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))?;
    parse_headless_option_values(&value)
}

fn parse_headless_option_values(value: &Value) -> Result<HeadlessOptionValues, String> {
    let Some(object) = value.as_object() else {
        return Err("headless option values JSON must be an object".to_string());
    };
    let mut parsed = HeadlessOptionValues::default();
    if let Some(global) = object.get("global") {
        parsed.global = option_value_object(global, "global")?;
    }
    if let Some(tasks) = object.get("tasks") {
        let Some(task_map) = tasks.as_object() else {
            return Err("headless option values field tasks must be an object".to_string());
        };
        for (key, value) in task_map {
            parsed.per_task.insert(
                key.clone(),
                option_value_object(value, &format!("tasks.{key}"))?,
            );
        }
    }
    for (key, value) in object {
        if key == "global" || key == "tasks" {
            continue;
        }
        parsed.global.insert(key.clone(), value.clone());
    }
    Ok(parsed)
}

fn option_value_object(value: &Value, label: &str) -> Result<BTreeMap<String, Value>, String> {
    let Some(object) = value.as_object() else {
        return Err(format!(
            "headless option values field {label} must be an object"
        ));
    };
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect())
}

fn task_option_values(task: &MaaTask, values: &HeadlessOptionValues) -> BTreeMap<String, Value> {
    let mut merged = values.global.clone();
    for key in [&task.entry, &task.name, &task.id] {
        if let Some(overrides) = values.per_task.get(key) {
            for (name, value) in overrides {
                merged.insert(name.clone(), value.clone());
            }
        }
    }
    merged
}

fn run_headless_acceptance_for_window(
    target: platform::AppWindow,
    tasks: Vec<MaaTask>,
    option_definitions: BTreeMap<String, Value>,
    option_values: HeadlessOptionValues,
    options: HeadlessAcceptanceOptions,
    project: PathBuf,
) -> Result<HeadlessWindowAcceptanceSummary, String> {
    let target_identity = if options.dry_run {
        None
    } else {
        window_identity_by_hwnd(target.hwnd).ok()
    };
    let completed_existing = if options.missing_only && !options.dry_run {
        completed_task_names_for_hwnd(&project, target.hwnd, false, target_identity.as_ref())?
    } else {
        BTreeSet::new()
    };
    let planned = tasks
        .iter()
        .filter(|task| !completed_existing.contains(&task.name))
        .cloned()
        .collect::<Vec<_>>();
    let mut reports = Vec::new();
    let mut failed_task = None;
    let mut stopped_reason = "completed".to_string();
    for (index, task) in planned.iter().enumerate() {
        let run_id = format!(
            "headless-{}-{}-{}-{}",
            target.hwnd,
            sanitize_file_part(&task.entry),
            index + 1,
            timestamp_ns()
        );
        let request = RunTaskRequest {
            hwnd: target.hwnd,
            entry: task.entry.clone(),
            task_name: Some(task.name.clone()),
            dry_run: options.dry_run,
            max_steps: options.max_steps,
            coordinate_mode: options.coordinate_mode,
            run_id: Some(run_id),
            pipeline_overrides: pipeline_overrides_for_task(
                task,
                &option_definitions,
                &task_option_values(task, &option_values),
            ),
        };
        match execute_maa_task(request) {
            Ok(report) => {
                if !report.completed {
                    stopped_reason = report.stopped_reason.clone();
                    failed_task = Some(task.name.clone());
                    reports.push(report);
                    break;
                }
                reports.push(report);
            }
            Err(err) => {
                stopped_reason = err;
                failed_task = Some(task.name.clone());
                break;
            }
        }
    }
    let newly_completed = reports.iter().filter(|report| report.completed).count();
    Ok(HeadlessWindowAcceptanceSummary {
        hwnd: target.hwnd,
        title: target.title,
        display: target.display,
        target_elevated: target.elevated,
        planned_tasks: planned.len(),
        skipped_existing_tasks: completed_existing.len(),
        completed_tasks: completed_existing.len() + newly_completed,
        failed_task,
        stopped_reason,
        reports,
    })
}

fn pipeline_overrides_for_task(
    task: &MaaTask,
    option_definitions: &BTreeMap<String, Value>,
    values: &BTreeMap<String, Value>,
) -> Option<Value> {
    let mut merged = json!({});
    let mut seen = BTreeSet::new();
    for option_name in &task.options {
        collect_option_override(
            option_name,
            option_definitions,
            values,
            &mut merged,
            &mut seen,
        );
    }
    (!merged.as_object().is_none_or(|object| object.is_empty())).then_some(merged)
}

fn collect_option_override(
    option_name: &str,
    option_definitions: &BTreeMap<String, Value>,
    values: &BTreeMap<String, Value>,
    merged: &mut Value,
    seen: &mut BTreeSet<String>,
) {
    if !seen.insert(option_name.to_string()) {
        return;
    }
    let Some(definition) = option_definitions.get(option_name) else {
        return;
    };
    match definition.get("type").and_then(Value::as_str).unwrap_or("") {
        "input" => {
            let input_values = input_values_for_option(option_name, definition, values);
            let override_value = substitute_input_placeholders(
                definition.get("pipeline_override").unwrap_or(&Value::Null),
                &input_values,
                definition.get("inputs").and_then(Value::as_array),
            );
            *merged = merge_objects(merged, &override_value);
        }
        "checkbox" => {
            let selected = option_value(option_name, definition, values)
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<BTreeSet<_>>();
            for item in definition
                .get("cases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                if !selected.contains(name) {
                    continue;
                }
                *merged = merge_objects(
                    merged,
                    item.get("pipeline_override").unwrap_or(&Value::Null),
                );
                for nested in option_names(item.get("option")) {
                    collect_option_override(&nested, option_definitions, values, merged, seen);
                }
            }
        }
        "select" | "switch" => {
            let selected = option_value(option_name, definition, values)
                .as_str()
                .unwrap_or_default()
                .to_string();
            for item in definition
                .get("cases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("name").and_then(Value::as_str) != Some(selected.as_str()) {
                    continue;
                }
                *merged = merge_objects(
                    merged,
                    item.get("pipeline_override").unwrap_or(&Value::Null),
                );
                for nested in option_names(item.get("option")) {
                    collect_option_override(&nested, option_definitions, values, merged, seen);
                }
                break;
            }
        }
        _ => {}
    }
}

fn default_option_value(definition: &Value) -> Value {
    match definition.get("type").and_then(Value::as_str).unwrap_or("") {
        "checkbox" => definition
            .get("default_case")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "input" => Value::Object(
            default_input_values(definition)
                .into_iter()
                .collect::<serde_json::Map<_, _>>(),
        ),
        _ => definition
            .get("default_case")
            .filter(|value| value.is_string())
            .cloned()
            .or_else(|| {
                definition
                    .get("cases")
                    .and_then(Value::as_array)
                    .and_then(|cases| cases.first())
                    .and_then(|item| item.get("name"))
                    .filter(|value| value.is_string())
                    .cloned()
            })
            .unwrap_or_else(|| Value::String(String::new())),
    }
}

fn option_value(option_name: &str, definition: &Value, values: &BTreeMap<String, Value>) -> Value {
    values
        .get(option_name)
        .cloned()
        .unwrap_or_else(|| default_option_value(definition))
}

fn input_values_for_option(
    option_name: &str,
    definition: &Value,
    values: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    let mut input_values = default_input_values(definition);
    let Some(value) = values.get(option_name) else {
        return input_values;
    };
    if let Some(object) = value.as_object() {
        for (key, item) in object {
            input_values.insert(key.clone(), item.clone());
        }
    } else {
        let input_names = definition
            .get("inputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        if input_names.len() == 1 {
            input_values.insert(input_names[0].to_string(), value.clone());
        }
    }
    input_values
}

fn default_input_values(definition: &Value) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    for input in definition
        .get("inputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = input.get("name").and_then(Value::as_str) else {
            continue;
        };
        values.insert(
            name.to_string(),
            input
                .get("default")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
    }
    values
}

fn option_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn substitute_input_placeholders(
    value: &Value,
    input_values: &BTreeMap<String, Value>,
    input_definitions: Option<&Vec<Value>>,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| substitute_input_placeholders(item, input_values, input_definitions))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, item)| {
                    (
                        key.clone(),
                        substitute_input_placeholders(item, input_values, input_definitions),
                    )
                })
                .collect(),
        ),
        Value::String(text) => substitute_input_string(text, input_values, input_definitions),
        _ => value.clone(),
    }
}

fn substitute_input_string(
    text: &str,
    input_values: &BTreeMap<String, Value>,
    input_definitions: Option<&Vec<Value>>,
) -> Value {
    if let Some(name) = exact_placeholder_name(text) {
        return coerce_input_value(
            input_values
                .get(name)
                .unwrap_or(&Value::String(String::new())),
            input_definition(input_definitions, name),
        );
    }
    Value::String(replace_placeholders(text, input_values))
}

fn exact_placeholder_name(text: &str) -> Option<&str> {
    text.strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .filter(|name| !name.is_empty() && !name.contains('{') && !name.contains('}'))
}

fn input_definition<'a>(
    input_definitions: Option<&'a Vec<Value>>,
    name: &str,
) -> Option<&'a Value> {
    input_definitions?
        .iter()
        .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
}

fn coerce_input_value(value: &Value, input_definition: Option<&Value>) -> Value {
    if input_definition
        .and_then(|item| item.get("pipeline_type"))
        .and_then(Value::as_str)
        == Some("int")
    {
        let parsed = value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
            .unwrap_or_default();
        return json!(parsed);
    }
    Value::String(value_to_plain_string(value))
}

fn replace_placeholders(text: &str, input_values: &BTreeMap<String, Value>) -> String {
    let mut out = String::new();
    let mut cursor = 0usize;
    while let Some(start) = text[cursor..].find('{') {
        let start = cursor + start;
        out.push_str(&text[cursor..start]);
        let Some(end_offset) = text[start + 1..].find('}') else {
            out.push_str(&text[start..]);
            return out;
        };
        let end = start + 1 + end_offset;
        let name = &text[start + 1..end];
        out.push_str(
            &input_values
                .get(name)
                .map(value_to_plain_string)
                .unwrap_or_default(),
        );
        cursor = end + 1;
    }
    out.push_str(&text[cursor..]);
    out
}

fn value_to_plain_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn completed_task_names_for_hwnd(
    project: &Path,
    hwnd: isize,
    dry_run: bool,
    expected_identity: Option<&WindowIdentity>,
) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    let dir = shikong_log_dir(project);
    if !dir.is_dir() {
        return Ok(names);
    }
    for entry in fs::read_dir(&dir).map_err(|err| format!("{}: {err}", dir.display()))? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with("task-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if data.get("hwnd").and_then(Value::as_i64) != Some(hwnd as i64)
            || data.get("dryRun").and_then(Value::as_bool) != Some(dry_run)
            || !accepted_task_report(&data)
            || !task_report_matches_window_identity(&data, expected_identity)
        {
            continue;
        }
        if let Some(task_name) = data.get("taskName").and_then(Value::as_str) {
            if !task_name.trim().is_empty() {
                names.insert(task_name.to_string());
            }
        }
    }
    Ok(names)
}

fn task_report_matches_window_identity(data: &Value, expected: Option<&WindowIdentity>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    ["initialWindowIdentity", "finalWindowIdentity"]
        .iter()
        .filter_map(|field| data.get(*field))
        .any(|identity| {
            identity.get("hwnd").and_then(Value::as_i64) == Some(expected.hwnd as i64)
                && json_u64_any(identity, &["processId", "process_id"])
                    == Some(expected.process_id as u64)
                && identity.get("title").and_then(Value::as_str) == Some(expected.title.as_str())
                && json_str_any(identity, &["processName", "process_name"])
                    .map(|name| {
                        expected.process_name.is_empty()
                            || name.is_empty()
                            || name.eq_ignore_ascii_case(&expected.process_name)
                    })
                    .unwrap_or(expected.process_name.is_empty())
        })
}

fn json_u64_any<'a>(value: &'a Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn json_str_any<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}

fn accepted_task_report(data: &Value) -> bool {
    if data.get("completed").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(steps) = data.get("steps").and_then(Value::as_array) else {
        return false;
    };
    let mut last_substantive_status = None;
    for step in steps {
        let status = step.get("status").and_then(Value::as_str).unwrap_or("");
        if matches!(
            status,
            "action-failed"
                | "candidate-cancelled"
                | "candidate-empty"
                | "candidate-timeout"
                | "capture-error"
                | "cancelled"
                | "window-identity-mismatch"
        ) {
            return false;
        }
        if status != "jump-back-return" {
            last_substantive_status = Some(status);
        }
    }
    !matches!(last_substantive_status, Some("miss" | "missing") | None)
}

fn save_headless_acceptance_report(report: &HeadlessAcceptanceReport) -> Result<(), String> {
    let root = project_root()?;
    let log_dir = shikong_log_dir(&root);
    fs::create_dir_all(&log_dir).map_err(|err| err.to_string())?;
    let text = serde_json::to_string_pretty(report).map_err(|err| err.to_string())?;
    let stamped = log_dir.join(format!("headless-acceptance-{}.json", timestamp_ns()));
    fs::write(&stamped, &text).map_err(|err| format!("{}: {err}", stamped.display()))?;
    let latest = root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("reports")
        .join("latest-headless-acceptance.json");
    if let Some(parent) = latest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&latest, text).map_err(|err| format!("{}: {err}", latest.display()))
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

fn safe_template_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("template path is empty".to_string());
    }
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(format!("unsafe template path: {value}"));
    }
    let mut path = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("unsafe template path: {value}"));
        }
        path.push(part);
    }
    Ok(path)
}

fn find_plan_template<'a>(
    inventory: &'a MaaInventory,
    item: &CropPlanItem,
) -> Option<&'a inventory::TemplateRef> {
    if let Some(template_id) = item.template_id.as_deref() {
        if let Some(template) = inventory
            .templates
            .iter()
            .find(|template| template.id == template_id)
        {
            return Some(template);
        }
    }
    if item.template.is_empty() {
        return None;
    }
    inventory
        .templates
        .iter()
        .find(|template| template.template == item.template)
}

struct RuntimeTemplateGuidance {
    category: &'static str,
    capture_scene: String,
    crop_target: &'static str,
    acceptance_criteria: &'static str,
    reject_if: &'static str,
    recommended_command: &'static str,
}

fn runtime_missing_note(row: &Value, project: &Path, guidance: &RuntimeTemplateGuidance) -> String {
    let template = row
        .get("template")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let maa_old = maa_old_image_path(project, template);
    let domain = row
        .get("domain")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tasks = string_array(row.get("tasks")).join(" | ");
    let nodes = string_array(row.get("nodes")).join(" | ");
    let pipelines = string_array(row.get("pipelines")).join(" | ");
    let rois = row
        .get("rois")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "[]".to_string());
    let best_manifest_score = row
        .get("bestManifestScore")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    format!(
        "runtimeMissing=true; category={category}; domain={domain}; tasks={tasks}; nodes={nodes}; pipelines={pipelines}; rois={rois}; bestManifestScore={best_manifest_score}; captureScene={capture_scene}; cropTarget={crop_target}; oldImage={}",
        maa_old.display(),
        category = guidance.category,
        capture_scene = guidance.capture_scene,
        crop_target = guidance.crop_target
    )
}

fn maa_old_image_path(project: &Path, template: &str) -> PathBuf {
    project
        .parent()
        .unwrap_or(project)
        .join(MAA_SOURCE_DIR)
        .join("assets")
        .join("resource")
        .join("base")
        .join("image")
        .join(template.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
}

fn runtime_plan_summary(items: &[CropPlanItem]) -> Value {
    let mut categories = BTreeMap::<String, usize>::new();
    for item in items {
        let category = item
            .category
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        *categories.entry(category).or_default() += 1;
    }
    json!({
        "items": items.len(),
        "categories": categories,
    })
}

fn runtime_capture_requirement(status: &Value) -> Option<String> {
    let window_status = status.get("windowStatus")?;
    let current = window_status
        .get("currentProcessElevated")
        .and_then(Value::as_bool)?;
    if current {
        return None;
    }
    let has_elevated_window = window_status
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows.iter().any(|window| {
                window
                    .get("elevated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    has_elevated_window.then(|| {
        "current capture/control process is not elevated while at least one 梦幻西游：时空 window is elevated; hwnd-targeted input requires running the helper/control app as administrator before interactive capture.".to_string()
    })
}

fn runtime_template_guidance(template: &str, row: &Value) -> RuntimeTemplateGuidance {
    if template.starts_with("mijing_cailiao/") {
        let material = Path::new(template)
            .file_stem()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| template.to_string());
        return RuntimeTemplateGuidance {
            category: "inventory-secret-realm-material",
            capture_scene: format!(
                "Open the backpack or material submission/storage view where this exact secret-realm material is visible: {material}."
            ),
            crop_target: "Crop the material item icon itself from the grid. Prefer the inner icon area and avoid variable quantity digits or selection glow unless they are unavoidable in the live UI.",
            acceptance_criteria: "The crop should be visually the same object as the old Maa material icon and should match inside the bag/material grid ROI used by 使用秘境材料.",
            reject_if: "Reject low-score matches from skill panels, furniture, activity rows, blank beige tiles, or any screenshot that does not show the named material in an inventory/material grid.",
            recommended_command: "npm run tauri:dev:admin, then use the UI drag-crop or a filled crop plan.",
        };
    }
    match template {
        "beibao/guoqi.png" => RuntimeTemplateGuidance {
            category: "inventory-expired-item",
            capture_scene: "Open the backpack with an expired item visible in the item grid.".to_string(),
            crop_target: "Crop the expired-item icon/overlay from the bag grid, not a panel control.",
            acceptance_criteria: "The crop must identify the expired item in the 整理背包 grid before the 使用 action.",
            reject_if: "Reject tiny red UI badges, close buttons, event markers, or any non-bag-grid red mark.",
            recommended_command: "npm run tauri:dev:admin, open bag, then crop from live preview.",
        },
        "beibao/hongluogeng.png"
        | "beibao/lvlugeng.png"
        | "beibao/xinmobaozhu.png"
        | "beibao/zhenfa.png" => {
            let item = Path::new(template)
                .file_stem()
                .map(|item| item.to_string_lossy().to_string())
                .unwrap_or_else(|| template.to_string());
            RuntimeTemplateGuidance {
                category: "inventory-item",
                capture_scene: format!("Open the backpack with the exact item visible: {item}."),
                crop_target: "Crop the item icon in the bag grid. Keep the crop tight enough to avoid neighboring slots.",
                acceptance_criteria: "The crop should select the intended inventory item before the follow-up OCR menu action.",
                reject_if: "Reject activity icons, skill icons, panel decoration, partial borders, or blank slot fragments.",
                recommended_command: "npm run tauri:dev:admin, open bag, then crop from live preview.",
            }
        }
        _ if template.starts_with("wujian/bcg/baicaogu_weizhi") => RuntimeTemplateGuidance {
            category: "wujian-baicaogu-move-tile",
            capture_scene: "Enter the 百草谷/帮派 map state used after the activity starts.".to_string(),
            crop_target: "Crop the real in-scene movement target tile/ground marker used by 百草谷-帮派-向下移动.",
            acceptance_criteria: "The crop should only appear at the intended map navigation position, not in the activity list.",
            reject_if: "Reject activity row images, buttons, beige panel backgrounds, or unrelated map/floor fragments.",
            recommended_command: "npm run capture:scene:admin after entering the 百草谷/九黎 map scene, then crop from the UI or capture_scene_templates.py.",
        },
        "wujian/bcg/baicaogu_shenshu_xiaoshi.png" => RuntimeTemplateGuidance {
            category: "wujian-baicaogu-state",
            capture_scene: "Capture the 百草谷 scene after the divine tree disappears/completion state is visible.".to_string(),
            crop_target: "Crop the actual scene/state marker that proves 神树消失.",
            acceptance_criteria: "The crop must distinguish the post-tree state from normal 百草谷 scene and activity rows.",
            reject_if: "Reject generic 参加 buttons, activity list rows, or unrelated beige/gold UI panels.",
            recommended_command: "npm run capture:scene:admin after progressing 百草谷 to the disappeared-tree state, then crop from the UI or capture_scene_templates.py.",
        },
        _ if template.starts_with("wujian/mz/mizhen_chuansongren") => RuntimeTemplateGuidance {
            category: "wujian-maze-teleporter-npc",
            capture_scene: "After starting 帮派迷阵, capture the in-scene teleporter NPC before clicking it.".to_string(),
            crop_target: "Crop distinctive NPC body/clothing/head pixels from the actual map scene.",
            acceptance_criteria: "The crop should click the real 迷阵传送人 and should not match decorative sidebars or panels.",
            reject_if: "Reject activity-panel borders, beige blank areas, wood posts, or unrelated character fragments.",
            recommended_command: "npm run capture:scene:admin after entering the 帮派迷阵 NPC scene, then crop from the UI or capture_scene_templates.py.",
        },
        _ if template.starts_with("wujian/mz/mz_mubiao_diban") => RuntimeTemplateGuidance {
            category: "wujian-maze-target-floor",
            capture_scene: "Inside 帮派迷阵, capture the target/end floor tile state.".to_string(),
            crop_target: "Crop the actual target floor tile pattern, not an ordinary floor or activity UI.",
            acceptance_criteria: "The crop should only trigger when the maze endpoint floor is visible.",
            reject_if: "Reject ordinary wooden floors, activity panel backgrounds, or generic tile textures without the endpoint marker.",
            recommended_command: "npm run capture:scene:admin at the 帮派迷阵 endpoint floor, then crop from the UI or capture_scene_templates.py.",
        },
        _ => RuntimeTemplateGuidance {
            category: "runtime-missing",
            capture_scene: format!(
                "Capture the real ShiKong state for nodes: {}.",
                string_array(row.get("nodes")).join(" | ")
            ),
            crop_target: "Crop the equivalent visual target used by the original Maa template.",
            acceptance_criteria: "The crop must hit the intended runtime target and avoid unrelated UI lookalikes.",
            reject_if: "Reject low-score visual-only candidates without matching task semantics.",
            recommended_command: "npm run tauri:dev:admin, then use the UI drag-crop or a filled crop plan.",
        },
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn save_task_report(report: &TaskRunReport) -> Result<(), String> {
    let root = project_root()?;
    let dir = shikong_log_dir(&root);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let run_part = report.run_id.as_deref().unwrap_or("no-runid");
    let file_name = format!(
        "task-{}-hwnd-{}-{}-{}.json",
        sanitize_file_part(&report.entry),
        report.hwnd,
        sanitize_file_part(run_part),
        timestamp_ns()
    );
    let path = dir.join(file_name);
    let text = serde_json::to_string_pretty(report).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())
}

fn shikong_log_dir(root: &Path) -> PathBuf {
    root.join("assets")
        .join("resource")
        .join("ShiKong")
        .join("logs")
}

fn client_aspect(width: u32, height: u32) -> Option<f32> {
    (height > 0).then_some(width as f32 / height as f32)
}

fn aspect_close_to_4x3(aspect: f32) -> bool {
    (aspect - ASPECT_4_3).abs() <= ASPECT_TOLERANCE
}

fn sanitize_file_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
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
        capture_source: CaptureSource::ImageFile,
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

fn timestamp_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn main() {
    platform::configure_process_dpi_awareness();
    if let Some(code) = maybe_run_headless_acceptance_cli() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_game_windows,
            privilege_status,
            restart_as_admin,
            launch_game_client,
            game_launch_status,
            focus_window,
            capture_window_preview,
            preview_client_roi,
            save_window_snapshot,
            old_template_preview,
            load_maa_inventory,
            template_coverage_report,
            pipeline_compat_report,
            migration_status_report,
            live_acceptance_report,
            refresh_live_acceptance_report,
            acceptance_plan_report,
            refresh_acceptance_plan_report,
            ocr_status,
            run_maa_task,
            cancel_maa_task,
            capture_template_roi,
            capture_template_client_roi,
            import_preview_image,
            capture_template_image_roi,
            write_crop_plan,
            write_runtime_missing_crop_plan,
            apply_crop_plan
        ])
        .run(tauri::generate_context!())
        .expect("error while running mhxy shikong control app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_client_roi_clamps_to_frame() {
        let frame = RgbFrame {
            width: 4,
            height: 3,
            pixels: (0..36).collect(),
            capture_source: CaptureSource::ImageFile,
        };
        let cropped = crop_client_roi(&frame, [2, 1, 10, 10]).expect("cropped");
        assert_eq!(cropped.width, 2);
        assert_eq!(cropped.height, 2);
        assert_eq!(
            cropped.pixels,
            vec![18, 19, 20, 21, 22, 23, 30, 31, 32, 33, 34, 35,]
        );
    }

    #[test]
    fn load_image_rgb_reads_saved_png() {
        let frame = RgbFrame {
            width: 2,
            height: 1,
            pixels: vec![255, 0, 0, 0, 255, 0],
            capture_source: CaptureSource::ImageFile,
        };
        let path = std::env::temp_dir().join(format!(
            "mhxy-shikong-load-image-test-{}.png",
            std::process::id()
        ));
        save_png(&frame, &path).expect("save png");
        let loaded = load_image_rgb(&path).expect("load png");
        let _ = std::fs::remove_file(&path);
        assert_eq!(loaded.width, frame.width);
        assert_eq!(loaded.height, frame.height);
        assert_eq!(loaded.pixels, frame.pixels);
    }

    #[test]
    fn safe_template_path_rejects_path_escape() {
        assert_eq!(
            safe_template_path("wujian/mz/mz_mubiao_diban.png").expect("safe path"),
            PathBuf::from("wujian")
                .join("mz")
                .join("mz_mubiao_diban.png")
        );
        assert!(safe_template_path("../secret.png").is_err());
        assert!(safe_template_path("wujian/../secret.png").is_err());
        assert!(safe_template_path("C:/secret.png").is_err());
        assert!(safe_template_path("/secret.png").is_err());
    }

    #[test]
    fn accepted_task_report_rejects_false_completion_statuses() {
        let false_complete = json!({
            "completed": true,
            "steps": [
                {"status": "hit"},
                {"status": "candidate-timeout"}
            ]
        });
        let trailing_miss = json!({
            "completed": true,
            "steps": [
                {"status": "hit"},
                {"status": "jump-back-return"},
                {"status": "miss"}
            ]
        });
        let accepted = json!({
            "completed": true,
            "steps": [
                {"status": "hit"},
                {"status": "jump-back-return"},
                {"status": "hit"}
            ]
        });

        assert!(!accepted_task_report(&false_complete));
        assert!(!accepted_task_report(&trailing_miss));
        assert!(accepted_task_report(&accepted));
    }

    #[test]
    fn completed_task_names_ignore_unaccepted_historical_reports() {
        let project = std::env::temp_dir().join(format!(
            "mhxy-shikong-completed-filter-test-{}-{}",
            std::process::id(),
            timestamp_ns()
        ));
        let log_dir = shikong_log_dir(&project);
        std::fs::create_dir_all(&log_dir).expect("create log dir");

        let accepted = json!({
            "hwnd": 1234,
            "dryRun": false,
            "completed": true,
            "taskName": "可信任务",
            "steps": [{"status": "hit"}]
        });
        let rejected = json!({
            "hwnd": 1234,
            "dryRun": false,
            "completed": true,
            "taskName": "假完成任务",
            "steps": [{"status": "hit"}, {"status": "action-failed"}]
        });
        std::fs::write(
            log_dir.join("task-accepted.json"),
            serde_json::to_string(&accepted).expect("serialize accepted"),
        )
        .expect("write accepted");
        std::fs::write(
            log_dir.join("task-rejected.json"),
            serde_json::to_string(&rejected).expect("serialize rejected"),
        )
        .expect("write rejected");

        let names =
            completed_task_names_for_hwnd(&project, 1234, false, None).expect("scan logs");
        let _ = std::fs::remove_dir_all(&project);

        assert!(names.contains("可信任务"));
        assert!(!names.contains("假完成任务"));
    }

    #[test]
    fn task_report_identity_matches_camel_and_legacy_process_fields() {
        let expected = WindowIdentity {
            hwnd: 1234,
            title: "梦幻西游：时空".to_string(),
            process_id: 5678,
            process_name: "MyGame_x64r".to_string(),
        };
        let camel = json!({
            "initialWindowIdentity": {
                "hwnd": 1234,
                "title": "梦幻西游：时空",
                "processId": 5678,
                "processName": "MyGame_x64r"
            }
        });
        let legacy = json!({
            "finalWindowIdentity": {
                "hwnd": 1234,
                "title": "梦幻西游：时空",
                "process_id": 5678,
                "process_name": "MyGame_x64r"
            }
        });

        assert!(task_report_matches_window_identity(&camel, Some(&expected)));
        assert!(task_report_matches_window_identity(&legacy, Some(&expected)));
    }

    #[test]
    fn parses_headless_acceptance_cli_flags() {
        let args = vec![
            "--headless-acceptance".to_string(),
            "--hwnd=100,200".to_string(),
            "--all-windows".to_string(),
            "--missing-only".to_string(),
            "--max-steps".to_string(),
            "77".to_string(),
            "--coordinate-mode=stretch1280x720".to_string(),
            "--option-values".to_string(),
            "assets/resource/ShiKong/headless_options.local.json".to_string(),
        ];
        let options = parse_headless_acceptance_options(&args)
            .expect("parse ok")
            .expect("headless mode");
        assert_eq!(options.hwnds, vec![100, 200]);
        assert!(options.all_windows);
        assert!(options.missing_only);
        assert!(!options.dry_run);
        assert_eq!(options.max_steps, Some(77));
        assert_eq!(
            options.option_values_path.as_deref(),
            Some("assets/resource/ShiKong/headless_options.local.json")
        );
        assert!(matches!(
            options.coordinate_mode,
            CoordinateMode::Stretch1280x720
        ));
    }

    #[test]
    fn ignores_cli_without_headless_acceptance_flag() {
        let args = vec!["--title".to_string(), "梦幻西游：时空".to_string()];
        assert!(parse_headless_acceptance_options(&args)
            .expect("parse ok")
            .is_none());
    }

    #[test]
    fn default_pipeline_overrides_match_ui_option_rules() {
        let mut option_definitions = BTreeMap::new();
        option_definitions.insert(
            "mode".to_string(),
            json!({
                "type": "select",
                "default_case": "B",
                "cases": [
                    {"name": "A", "pipeline_override": {"node": {"next": ["a"]}}},
                    {
                        "name": "B",
                        "pipeline_override": {"node": {"next": ["b"]}},
                        "option": ["rounds"]
                    }
                ]
            }),
        );
        option_definitions.insert(
            "rounds".to_string(),
            json!({
                "type": "input",
                "inputs": [{"name": "count", "pipeline_type": "int", "default": "3"}],
                "pipeline_override": {
                    "counter": {"custom_action_param": {"target": "{count}"}},
                    "label": {"text": "round-{count}"}
                }
            }),
        );
        let task = MaaTask {
            id: "1|task|entry".to_string(),
            name: "task".to_string(),
            entry: "entry".to_string(),
            pipeline: None,
            options: vec!["mode".to_string()],
            description: None,
        };
        let overrides = pipeline_overrides_for_task(&task, &option_definitions, &BTreeMap::new())
            .expect("overrides");
        assert_eq!(overrides["node"]["next"], json!(["b"]));
        assert_eq!(
            overrides["counter"]["custom_action_param"]["target"],
            json!(3)
        );
        assert_eq!(overrides["label"]["text"], json!("round-3"));
    }

    #[test]
    fn user_pipeline_overrides_replace_defaults() {
        let mut option_definitions = BTreeMap::new();
        option_definitions.insert(
            "mode".to_string(),
            json!({
                "type": "select",
                "cases": [
                    {"name": "A", "pipeline_override": {"node": {"next": ["a"]}}},
                    {"name": "B", "pipeline_override": {"node": {"next": ["b"]}}}
                ]
            }),
        );
        option_definitions.insert(
            "rounds".to_string(),
            json!({
                "type": "input",
                "inputs": [{"name": "count", "pipeline_type": "int", "default": "3"}],
                "pipeline_override": {"counter": {"target": "{count}"}}
            }),
        );
        let task = MaaTask {
            id: "1|task|entry".to_string(),
            name: "task".to_string(),
            entry: "entry".to_string(),
            pipeline: None,
            options: vec!["mode".to_string(), "rounds".to_string()],
            description: None,
        };
        let values = BTreeMap::from([
            ("mode".to_string(), json!("B")),
            ("rounds".to_string(), json!({"count": "9"})),
        ]);
        let overrides =
            pipeline_overrides_for_task(&task, &option_definitions, &values).expect("overrides");
        assert_eq!(overrides["node"]["next"], json!(["b"]));
        assert_eq!(overrides["counter"]["target"], json!(9));
    }

    #[test]
    fn parses_headless_option_values_and_task_precedence() {
        let parsed = parse_headless_option_values(&json!({
            "global": {"mode": "global", "rounds": {"count": 1}},
            "tasks": {
                "entry": {"mode": "entry"},
                "task": {"rounds": {"count": 2}},
                "1|task|entry": {"mode": "id"}
            },
            "loose": "global-loose"
        }))
        .expect("parse options");
        let task = MaaTask {
            id: "1|task|entry".to_string(),
            name: "task".to_string(),
            entry: "entry".to_string(),
            pipeline: None,
            options: Vec::new(),
            description: None,
        };
        let values = task_option_values(&task, &parsed);
        assert_eq!(values["mode"], json!("id"));
        assert_eq!(values["rounds"], json!({"count": 2}));
        assert_eq!(values["loose"], json!("global-loose"));
    }

    #[test]
    fn default_checkbox_overrides_selected_cases() {
        let mut option_definitions = BTreeMap::new();
        option_definitions.insert(
            "items".to_string(),
            json!({
                "type": "checkbox",
                "default_case": ["apple", "pear"],
                "cases": [
                    {"name": "apple", "pipeline_override": {"apple_node": {"enabled": true}}},
                    {"name": "pear", "pipeline_override": {"pear_node": {"enabled": true}}},
                    {"name": "banana", "pipeline_override": {"banana_node": {"enabled": true}}}
                ]
            }),
        );
        let task = MaaTask {
            id: "1|task|entry".to_string(),
            name: "task".to_string(),
            entry: "entry".to_string(),
            pipeline: None,
            options: vec!["items".to_string()],
            description: None,
        };
        let overrides = pipeline_overrides_for_task(&task, &option_definitions, &BTreeMap::new())
            .expect("overrides");
        assert_eq!(overrides["apple_node"]["enabled"], json!(true));
        assert_eq!(overrides["pear_node"]["enabled"], json!(true));
        assert!(overrides.get("banana_node").is_none());
    }

    #[test]
    fn acceptance_order_moves_stop_app_to_end() {
        let tasks = vec![
            MaaTask {
                id: "1|first|first".to_string(),
                name: "first".to_string(),
                entry: "first".to_string(),
                pipeline: None,
                options: Vec::new(),
                description: None,
            },
            MaaTask {
                id: "2|停止游戏|stop".to_string(),
                name: "停止游戏".to_string(),
                entry: "stop".to_string(),
                pipeline: None,
                options: Vec::new(),
                description: None,
            },
            MaaTask {
                id: "3|last|last".to_string(),
                name: "last".to_string(),
                entry: "last".to_string(),
                pipeline: None,
                options: Vec::new(),
                description: None,
            },
        ];
        let ordered = acceptance_ordered_tasks(&tasks);
        assert_eq!(
            ordered
                .iter()
                .map(|task| task.entry.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "last", "stop"]
        );
    }

    #[test]
    fn client_aspect_uses_four_by_three_tolerance() {
        let aspect = client_aspect(764, 573).expect("aspect");
        assert!(aspect_close_to_4x3(aspect));
        assert!(!aspect_close_to_4x3(16.0 / 9.0));
        assert!(client_aspect(100, 0).is_none());
    }

    #[test]
    fn runtime_template_guidance_classifies_remaining_domains() {
        let row = json!({"nodes": ["点击迷阵人员-图片"]});
        let material = runtime_template_guidance("mijing_cailiao/bulaogen.png", &row);
        assert_eq!(material.category, "inventory-secret-realm-material");
        assert!(material.capture_scene.contains("bulaogen"));

        let teleporter = runtime_template_guidance("wujian/mz/mizhen_chuansongren3.png", &row);
        assert_eq!(teleporter.category, "wujian-maze-teleporter-npc");
        assert!(teleporter.reject_if.contains("activity-panel"));

        let bag_item = runtime_template_guidance("beibao/zhenfa.png", &row);
        assert_eq!(bag_item.category, "inventory-item");
    }

    #[test]
    fn runtime_plan_summary_counts_guidance_categories() {
        let items = vec![
            CropPlanItem {
                category: Some("inventory-item".to_string()),
                ..CropPlanItem::default()
            },
            CropPlanItem {
                category: Some("inventory-item".to_string()),
                ..CropPlanItem::default()
            },
            CropPlanItem {
                category: Some("wujian-maze-target-floor".to_string()),
                ..CropPlanItem::default()
            },
        ];
        let summary = runtime_plan_summary(&items);
        assert_eq!(summary["items"], 3);
        assert_eq!(summary["categories"]["inventory-item"], 2);
        assert_eq!(summary["categories"]["wujian-maze-target-floor"], 1);
    }
}
