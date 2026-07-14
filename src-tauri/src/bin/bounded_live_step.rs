//! Bounded elevated HWND live-step helper for P4 home-vitality evidence.
//!
//! Supports match-only precheck, hotkey, and image_click through the project
//! PostMessage path only. Fail-closed on identity drift, privilege mismatch,
//! unreliable capture, and missing manual confirmation for click targets.

#[path = "../runtime/capture_health.rs"]
mod capture_health;
#[allow(dead_code)]
#[path = "../platform.rs"]
mod platform;
#[allow(dead_code)]
#[path = "../runtime/vision_match.rs"]
mod vision_match;

use capture_health::apply_health_to_captured_frame;
use image::ImageReader;
use platform::{
    capture_client_rgb_strict, current_process_elevated, post_hotkey, post_mouse_click,
    window_for_hwnd, AppWindow, HwndPoint, RgbFrame,
};
use serde::Serialize;
use std::{
    env, fs,
    path::PathBuf,
    process,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use vision_match::{match_template_budgeted, SearchRoi, TemplateMatch};

const OUTPUT_MARKER: &str = "BOUNDED_LIVE_STEP_JSON=";

#[derive(Debug, Clone)]
enum StepMode {
    MatchOnly,
    Hotkey,
    ImageClick,
}

#[derive(Debug, Clone)]
struct ExpectedIdentity {
    hwnd: isize,
    pid: u32,
    title: String,
    process_name: String,
    client_width: u32,
    client_height: u32,
    elevated: bool,
}

#[derive(Debug, Clone)]
struct ManualConfirmation {
    version: u32,
    target_id: String,
    binding_fingerprint: String,
    approved_at: String,
}

#[derive(Debug, Clone)]
struct StepArgs {
    mode: StepMode,
    expected: ExpectedIdentity,
    allow_input: bool,
    hotkey: Option<String>,
    template: Option<PathBuf>,
    roi: Option<SearchRoi>,
    threshold: f32,
    button: String,
    target_id: Option<String>,
    target_binding_fingerprint: Option<String>,
    manual_confirmation: Option<ManualConfirmation>,
    observe_ms: u64,
    report_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetWindow {
    hwnd: isize,
    pid: u32,
    title: String,
    process_name: String,
    client_width: u32,
    client_height: u32,
    elevated: Option<bool>,
}

impl From<&AppWindow> for TargetWindow {
    fn from(window: &AppWindow) -> Self {
        Self {
            hwnd: window.hwnd,
            pid: window.process_id,
            title: window.title.clone(),
            process_name: window.process_name.clone(),
            client_width: window.client_width,
            client_height: window.client_height,
            elevated: window.elevated,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForegroundSnapshot {
    hwnd: isize,
    cursor_x: i32,
    cursor_y: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchBox {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    score: f32,
}

impl From<TemplateMatch> for MatchBox {
    fn from(matched: TemplateMatch) -> Self {
        Self {
            x: matched.x,
            y: matched.y,
            width: matched.width,
            height: matched.height,
            score: matched.score,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureObservation {
    frame_hash: String,
    capture_provider: platform::CaptureProvider,
    capture_reliability: platform::CaptureReliability,
    fallback_used: bool,
    strict_target_source: bool,
    control_eligible: bool,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputResultRecord {
    hwnd: isize,
    sent_messages: u32,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepReport {
    kind: &'static str,
    version: u32,
    mode: &'static str,
    input_sent: bool,
    allow_input: bool,
    current_process_elevated: bool,
    target: TargetWindow,
    expected: TargetWindow,
    privilege: String,
    match_box: Option<MatchBox>,
    matched: Option<bool>,
    threshold: Option<f32>,
    template_path: Option<String>,
    hotkey: Option<String>,
    click_point: Option<HwndPoint>,
    manual_confirmation: Option<ManualConfirmationRecord>,
    before_capture: Option<CaptureObservation>,
    after_capture: Option<CaptureObservation>,
    frame_delta_ratio: Option<f64>,
    input: Option<InputResultRecord>,
    foreground_before: ForegroundSnapshot,
    foreground_after: ForegroundSnapshot,
    foreground_unchanged: bool,
    cursor_unchanged: bool,
    observe_ms: u64,
    elapsed_ms: u64,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManualConfirmationRecord {
    version: u32,
    target_id: String,
    binding_fingerprint: String,
    approved_at: String,
}

fn usage() -> &'static str {
    "Usage: bounded_live_step --mode <match_only|hotkey|image_click> --hwnd <HWND> --pid <PID> --title <TITLE> --process-name <NAME> --client-width <W> --client-height <H> --expected-elevated <true|false> [--allow-input] [--hotkey ALT+N] [--template PATH --roi x,y,w,h --threshold 0.86] [--target-id ID --binding-fingerprint FP --manual-confirmation-json JSON] [--observe-ms 900] [--report-path PATH]"
}

fn option_value(arguments: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    *index += 1;
    arguments
        .get(*index)
        .cloned()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn parse_u32(value: &str, name: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn parse_bool(value: &str, name: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("{name} must be true or false")),
    }
}

fn parse_roi(value: &str) -> Result<SearchRoi, String> {
    let parts: Vec<&str> = value.split(',').collect();
    if parts.len() != 4 {
        return Err("--roi must use x,y,width,height".to_string());
    }
    let x = parse_u32(parts[0].trim(), "roi x")?;
    let y = parse_u32(parts[1].trim(), "roi y")?;
    let w = parse_u32(parts[2].trim(), "roi width")?;
    let h = parse_u32(parts[3].trim(), "roi height")?;
    if w == 0 || h == 0 {
        return Err("--roi width and height must be positive".to_string());
    }
    Ok(SearchRoi { x, y, w, h })
}

fn parse_mode(value: &str) -> Result<StepMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "match_only" | "match-only" | "wait_image" => Ok(StepMode::MatchOnly),
        "hotkey" => Ok(StepMode::Hotkey),
        "image_click" | "image-click" | "click_image" => Ok(StepMode::ImageClick),
        _ => Err("--mode must be match_only, hotkey, or image_click".to_string()),
    }
}

fn parse_manual_confirmation(raw: &str) -> Result<ManualConfirmation, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("manual confirmation JSON invalid: {error}"))?;
    let version = value
        .get("version")
        .and_then(|item| item.as_u64())
        .unwrap_or(1) as u32;
    let target_id = value
        .get("targetId")
        .or_else(|| value.get("target_id"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let binding_fingerprint = value
        .get("bindingFingerprint")
        .or_else(|| value.get("binding_fingerprint"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let approved_at = value
        .get("approvedAt")
        .or_else(|| value.get("approved_at"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if target_id.is_empty() || binding_fingerprint.is_empty() || approved_at.is_empty() {
        return Err("manual confirmation requires targetId, bindingFingerprint, and approvedAt".to_string());
    }
    Ok(ManualConfirmation {
        version,
        target_id,
        binding_fingerprint,
        approved_at,
    })
}

fn parse_args() -> Result<StepArgs, String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        println!("{}", usage());
        process::exit(0);
    }

    let mut mode = None;
    let mut hwnd = None;
    let mut pid = None;
    let mut title = None;
    let mut process_name = None;
    let mut client_width = None;
    let mut client_height = None;
    let mut expected_elevated = None;
    let mut allow_input = false;
    let mut hotkey = None;
    let mut template = None;
    let mut roi = None;
    let mut threshold = 0.86f32;
    let mut button = "left".to_string();
    let mut target_id = None;
    let mut target_binding_fingerprint = None;
    let mut manual_confirmation = None;
    let mut observe_ms = 900u64;
    let mut report_path = None;
    let mut index = 0usize;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--mode" => {
                mode = Some(parse_mode(&option_value(&arguments, &mut index, "--mode")?)?);
            }
            "--hwnd" => {
                let value = option_value(&arguments, &mut index, "--hwnd")?;
                let parsed = value
                    .parse::<i64>()
                    .map_err(|_| "--hwnd must be an integer".to_string())?;
                if parsed <= 0 {
                    return Err("--hwnd must be positive".to_string());
                }
                hwnd = Some(parsed as isize);
            }
            "--pid" => {
                pid = Some(parse_u32(
                    &option_value(&arguments, &mut index, "--pid")?,
                    "--pid",
                )?);
            }
            "--title" => {
                title = Some(option_value(&arguments, &mut index, "--title")?);
            }
            "--process-name" => {
                process_name = Some(option_value(&arguments, &mut index, "--process-name")?);
            }
            "--client-width" => {
                client_width = Some(parse_u32(
                    &option_value(&arguments, &mut index, "--client-width")?,
                    "--client-width",
                )?);
            }
            "--client-height" => {
                client_height = Some(parse_u32(
                    &option_value(&arguments, &mut index, "--client-height")?,
                    "--client-height",
                )?);
            }
            "--expected-elevated" => {
                expected_elevated = Some(parse_bool(
                    &option_value(&arguments, &mut index, "--expected-elevated")?,
                    "--expected-elevated",
                )?);
            }
            "--allow-input" => allow_input = true,
            "--hotkey" => {
                hotkey = Some(option_value(&arguments, &mut index, "--hotkey")?);
            }
            "--template" => {
                template = Some(PathBuf::from(option_value(
                    &arguments,
                    &mut index,
                    "--template",
                )?));
            }
            "--roi" => {
                roi = Some(parse_roi(&option_value(&arguments, &mut index, "--roi")?)?);
            }
            "--threshold" => {
                let value = option_value(&arguments, &mut index, "--threshold")?;
                let parsed = value
                    .parse::<f32>()
                    .map_err(|_| "--threshold must be a number".to_string())?;
                if !parsed.is_finite() || !(0.0..=1.0).contains(&parsed) {
                    return Err("--threshold must be within 0..1".to_string());
                }
                threshold = parsed;
            }
            "--button" => {
                button = option_value(&arguments, &mut index, "--button")?;
            }
            "--target-id" => {
                target_id = Some(option_value(&arguments, &mut index, "--target-id")?);
            }
            "--binding-fingerprint" => {
                target_binding_fingerprint =
                    Some(option_value(&arguments, &mut index, "--binding-fingerprint")?);
            }
            "--manual-confirmation-json" => {
                manual_confirmation = Some(parse_manual_confirmation(&option_value(
                    &arguments,
                    &mut index,
                    "--manual-confirmation-json",
                )?)?);
            }
            "--observe-ms" => {
                observe_ms = option_value(&arguments, &mut index, "--observe-ms")?
                    .parse::<u64>()
                    .map_err(|_| "--observe-ms must be an unsigned integer".to_string())?;
            }
            "--report-path" => {
                report_path = Some(PathBuf::from(option_value(
                    &arguments,
                    &mut index,
                    "--report-path",
                )?));
            }
            unknown => return Err(format!("unknown argument {unknown}; {}", usage())),
        }
        index += 1;
    }

    if !(0..=10_000).contains(&observe_ms) {
        return Err("--observe-ms must be within 0..10000".to_string());
    }

    Ok(StepArgs {
        mode: mode.ok_or_else(|| "--mode is required".to_string())?,
        expected: ExpectedIdentity {
            hwnd: hwnd.ok_or_else(|| "--hwnd is required".to_string())?,
            pid: pid.ok_or_else(|| "--pid is required".to_string())?,
            title: title.ok_or_else(|| "--title is required".to_string())?,
            process_name: process_name.ok_or_else(|| "--process-name is required".to_string())?,
            client_width: client_width.ok_or_else(|| "--client-width is required".to_string())?,
            client_height: client_height
                .ok_or_else(|| "--client-height is required".to_string())?,
            elevated: expected_elevated
                .ok_or_else(|| "--expected-elevated is required".to_string())?,
        },
        allow_input,
        hotkey,
        template,
        roi,
        threshold,
        button,
        target_id,
        target_binding_fingerprint,
        manual_confirmation,
        observe_ms,
        report_path,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn normalize_process_name(value: &str) -> String {
    let trimmed = value.trim();
    let without_exe = trimmed
        .strip_suffix(".exe")
        .or_else(|| trimmed.strip_suffix(".EXE"))
        .unwrap_or(trimmed);
    without_exe.to_ascii_lowercase()
}

fn verify_expected(expected: &ExpectedIdentity, actual: &AppWindow) -> Result<(), String> {
    if actual.hwnd != expected.hwnd {
        return Err(format!(
            "hwnd mismatch: expected {} got {}",
            expected.hwnd, actual.hwnd
        ));
    }
    if actual.process_id != expected.pid {
        return Err(format!(
            "pid mismatch: expected {} got {}",
            expected.pid, actual.process_id
        ));
    }
    let expected_title = expected.title.trim();
    let actual_title = actual.title.trim();
    // Allow "*" / empty expected title for elevated launchers that cannot
    // reliably preserve non-ASCII argv encoding.
    if !expected_title.is_empty()
        && expected_title != "*"
        && actual_title != expected_title
        && !actual_title.contains(expected_title)
        && !expected_title.contains(actual_title)
    {
        return Err(format!(
            "title mismatch: expected {:?} got {:?}",
            expected.title, actual.title
        ));
    }
    if normalize_process_name(&actual.process_name) != normalize_process_name(&expected.process_name)
    {
        return Err(format!(
            "process mismatch: expected {:?} got {:?}",
            expected.process_name, actual.process_name
        ));
    }
    if actual.client_width != expected.client_width || actual.client_height != expected.client_height
    {
        return Err(format!(
            "client size mismatch: expected {}x{} got {}x{}",
            expected.client_width,
            expected.client_height,
            actual.client_width,
            actual.client_height
        ));
    }
    match actual.elevated {
        Some(value) if value == expected.elevated => Ok(()),
        Some(value) => Err(format!(
            "elevated mismatch: expected {} got {}",
            expected.elevated, value
        )),
        None => Err("target elevated state is unknown".to_string()),
    }
}

fn privilege_label(controller_elevated: bool, target_elevated: bool) -> String {
    if target_elevated && !controller_elevated {
        "insufficient".to_string()
    } else if target_elevated && controller_elevated {
        "elevated".to_string()
    } else {
        "same".to_string()
    }
}

fn validate_privilege(expected: &ExpectedIdentity) -> Result<(bool, String), String> {
    let controller_elevated = current_process_elevated();
    if expected.elevated && !controller_elevated {
        return Err(
            "administrator privileges required: target hwnd is elevated but this process is not"
                .to_string(),
        );
    }
    Ok((
        controller_elevated,
        privilege_label(controller_elevated, expected.elevated),
    ))
}

#[cfg(windows)]
fn foreground_snapshot() -> Result<ForegroundSnapshot, String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow};

    unsafe {
        let hwnd = GetForegroundWindow().0 as isize;
        let mut point = POINT { x: 0, y: 0 };
        GetCursorPos(&mut point).map_err(|error| format!("GetCursorPos failed: {error}"))?;
        Ok(ForegroundSnapshot {
            hwnd,
            cursor_x: point.x,
            cursor_y: point.y,
        })
    }
}

#[cfg(not(windows))]
fn foreground_snapshot() -> Result<ForegroundSnapshot, String> {
    Err("foreground snapshot is only implemented on Windows".to_string())
}

fn load_image_rgb(path: &PathBuf) -> Result<RgbFrame, String> {
    let image = ImageReader::open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?
        .decode()
        .map_err(|error| format!("{}: {error}", path.display()))?
        .to_rgb8();
    Ok(RgbFrame {
        width: image.width(),
        height: image.height(),
        pixels: image.into_raw(),
    })
}

fn capture_observation(
    expected: &ExpectedIdentity,
) -> Result<(CaptureObservation, RgbFrame), String> {
    let before = window_for_hwnd(expected.hwnd)?;
    verify_expected(expected, &before)?;
    let captured = capture_client_rgb_strict(expected.hwnd)?;
    let after = window_for_hwnd(expected.hwnd)?;
    verify_expected(expected, &after)?;
    let captured = apply_health_to_captured_frame(
        captured,
        Some(expected.client_width),
        Some(expected.client_height),
        None,
    );
    if !captured.metadata.permits_control_decision() {
        return Err(format!(
            "strict capture is not health-verified: {:?}/{:?}",
            captured.metadata.provider, captured.metadata.reliability
        ));
    }
    Ok((
        CaptureObservation {
            frame_hash: captured.metadata.frame_hash.clone(),
            capture_provider: captured.metadata.provider,
            capture_reliability: captured.metadata.reliability,
            fallback_used: captured.metadata.fallback_used,
            strict_target_source: captured.metadata.is_strict_target_source(),
            control_eligible: captured.metadata.permits_control_decision(),
            width: captured.rgb.width,
            height: captured.rgb.height,
        },
        captured.rgb,
    ))
}

fn frame_delta_ratio(before: &RgbFrame, after: &RgbFrame) -> f64 {
    if before.width != after.width
        || before.height != after.height
        || before.pixels.len() != after.pixels.len()
        || before.pixels.is_empty()
    {
        return 1.0;
    }
    let mut changed = 0usize;
    for (left, right) in before.pixels.iter().zip(after.pixels.iter()) {
        if left != right {
            changed += 1;
        }
    }
    changed as f64 / before.pixels.len() as f64
}

fn image_click_point(matched: &TemplateMatch) -> Result<HwndPoint, String> {
    let x = matched.x.saturating_add(matched.width / 2);
    let y = matched.y.saturating_add(matched.height / 2);
    Ok(HwndPoint { x, y })
}

fn validate_manual_confirmation(args: &StepArgs) -> Result<ManualConfirmationRecord, String> {
    let target_id = args
        .target_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "image_click requires --target-id".to_string())?;
    let fingerprint = args
        .target_binding_fingerprint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "image_click requires --binding-fingerprint".to_string())?;
    let confirmation = args
        .manual_confirmation
        .as_ref()
        .ok_or_else(|| "image_click requires --manual-confirmation-json".to_string())?;
    if confirmation.target_id.trim() != target_id {
        return Err(format!(
            "manual confirmation target mismatch: record={} step={}",
            confirmation.target_id, target_id
        ));
    }
    if confirmation.binding_fingerprint.trim() != fingerprint {
        return Err("manual confirmation binding fingerprint mismatch".to_string());
    }
    if confirmation.approved_at.trim().is_empty() {
        return Err("manual confirmation approvedAt is empty".to_string());
    }
    Ok(ManualConfirmationRecord {
        version: confirmation.version,
        target_id: confirmation.target_id.clone(),
        binding_fingerprint: confirmation.binding_fingerprint.clone(),
        approved_at: confirmation.approved_at.clone(),
    })
}

fn mode_name(mode: &StepMode) -> &'static str {
    match mode {
        StepMode::MatchOnly => "match_only",
        StepMode::Hotkey => "hotkey",
        StepMode::ImageClick => "image_click",
    }
}

fn run_step(args: StepArgs) -> Result<StepReport, String> {
    let started = Instant::now();
    let (controller_elevated, privilege) = validate_privilege(&args.expected)?;
    let live = window_for_hwnd(args.expected.hwnd)?;
    verify_expected(&args.expected, &live)?;
    let expected_target = TargetWindow {
        hwnd: args.expected.hwnd,
        pid: args.expected.pid,
        title: args.expected.title.clone(),
        process_name: args.expected.process_name.clone(),
        client_width: args.expected.client_width,
        client_height: args.expected.client_height,
        elevated: Some(args.expected.elevated),
    };
    let foreground_before = foreground_snapshot()?;

    let mut match_box = None;
    let mut matched = None;
    let mut template_path = None;
    let mut threshold = None;
    let mut hotkey = None;
    let mut click_point = None;
    let mut manual_confirmation = None;
    let mut before_capture = None;
    let mut after_capture = None;
    let mut frame_delta = None;
    let mut input = None;
    let mut input_sent = false;

    match args.mode {
        StepMode::MatchOnly => {
            let template = args
                .template
                .clone()
                .ok_or_else(|| "match_only requires --template".to_string())?;
            let roi = args
                .roi
                .ok_or_else(|| "match_only requires --roi".to_string())?;
            let (capture, frame) = capture_observation(&args.expected)?;
            let template_frame = load_image_rgb(&template)?;
            let found =
                match_template_budgeted(&frame, &template_frame, Some(roi), true, || Ok(()))?;
            let box_value = MatchBox::from(found);
            let is_match = box_value.score >= args.threshold;
            if !is_match {
                return Err(format!(
                    "match_only threshold not met: score={} threshold={}",
                    box_value.score, args.threshold
                ));
            }
            match_box = Some(box_value);
            matched = Some(true);
            template_path = Some(template.to_string_lossy().to_string());
            threshold = Some(args.threshold);
            before_capture = Some(capture);
        }
        StepMode::Hotkey => {
            if !args.allow_input {
                return Err("hotkey requires --allow-input".to_string());
            }
            let key = args
                .hotkey
                .clone()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "hotkey requires --hotkey".to_string())?;
            let (capture_before, frame_before) = capture_observation(&args.expected)?;
            let result = post_hotkey(args.expected.hwnd, &key)?;
            input_sent = true;
            input = Some(InputResultRecord {
                hwnd: result.hwnd,
                sent_messages: result.sent_messages,
                detail: result.detail,
            });
            if args.observe_ms > 0 {
                thread::sleep(Duration::from_millis(args.observe_ms));
            }
            let (capture_after, frame_after) = capture_observation(&args.expected)?;
            frame_delta = Some(frame_delta_ratio(&frame_before, &frame_after));
            before_capture = Some(capture_before);
            after_capture = Some(capture_after);
            hotkey = Some(key);
        }
        StepMode::ImageClick => {
            if !args.allow_input {
                return Err("image_click requires --allow-input".to_string());
            }
            manual_confirmation = Some(validate_manual_confirmation(&args)?);
            let template = args
                .template
                .clone()
                .ok_or_else(|| "image_click requires --template".to_string())?;
            let roi = args
                .roi
                .ok_or_else(|| "image_click requires --roi".to_string())?;
            let (capture_before, frame_before) = capture_observation(&args.expected)?;
            let template_frame = load_image_rgb(&template)?;
            let found =
                match_template_budgeted(&frame_before, &template_frame, Some(roi), true, || Ok(()))?;
            let box_value = MatchBox::from(found.clone());
            if box_value.score < args.threshold {
                return Err(format!(
                    "image_click threshold not met: score={} threshold={}",
                    box_value.score, args.threshold
                ));
            }
            let point = image_click_point(&found)?;
            let result = post_mouse_click(args.expected.hwnd, point, &args.button)?;
            input_sent = true;
            input = Some(InputResultRecord {
                hwnd: result.hwnd,
                sent_messages: result.sent_messages,
                detail: result.detail,
            });
            if args.observe_ms > 0 {
                thread::sleep(Duration::from_millis(args.observe_ms));
            }
            let (capture_after, frame_after) = capture_observation(&args.expected)?;
            frame_delta = Some(frame_delta_ratio(&frame_before, &frame_after));
            before_capture = Some(capture_before);
            after_capture = Some(capture_after);
            match_box = Some(box_value);
            matched = Some(true);
            template_path = Some(template.to_string_lossy().to_string());
            threshold = Some(args.threshold);
            click_point = Some(point);
        }
    }

    let foreground_after = foreground_snapshot()?;
    let final_window = window_for_hwnd(args.expected.hwnd)?;
    verify_expected(&args.expected, &final_window)?;

    Ok(StepReport {
        kind: "mhxy-shikong.bounded-live-step",
        version: 1,
        mode: mode_name(&args.mode),
        input_sent,
        allow_input: args.allow_input,
        current_process_elevated: controller_elevated,
        target: TargetWindow::from(&final_window),
        expected: expected_target,
        privilege,
        match_box,
        matched,
        threshold,
        template_path,
        hotkey,
        click_point,
        manual_confirmation,
        before_capture,
        after_capture,
        frame_delta_ratio: frame_delta,
        input,
        foreground_before: foreground_before.clone(),
        foreground_after: foreground_after.clone(),
        foreground_unchanged: foreground_before.hwnd == foreground_after.hwnd,
        cursor_unchanged: foreground_before.cursor_x == foreground_after.cursor_x
            && foreground_before.cursor_y == foreground_after.cursor_y,
        observe_ms: args.observe_ms,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        created_at_ms: now_ms(),
    })
}

fn emit_report(args: &StepArgs, report: &StepReport) -> Result<(), String> {
    let json = serde_json::to_string(report)
        .map_err(|error| format!("could not serialize report: {error}"))?;
    if let Some(path) = &args.report_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("could not create report directory: {error}"))?;
        }
        fs::write(path, format!("{json}\n"))
            .map_err(|error| format!("could not write report path: {error}"))?;
    }
    println!("{OUTPUT_MARKER}{json}");
    Ok(())
}

fn main() {
    match parse_args() {
        Ok(args) => match run_step(args.clone()).and_then(|report| {
            emit_report(&args, &report)?;
            Ok(report)
        }) {
            Ok(_) => process::exit(0),
            Err(error) => {
                eprintln!("bounded live step failed: {error}");
                process::exit(2);
            }
        },
        Err(error) => {
            eprintln!("bounded live step failed: {error}");
            process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roi_requires_positive_dimensions() {
        let roi = parse_roi("10,20,30,40").expect("valid roi");
        assert_eq!((roi.x, roi.y, roi.w, roi.h), (10, 20, 30, 40));
        assert!(parse_roi("10,20,0,40").is_err());
    }

    #[test]
    fn privilege_label_marks_insufficient_controller() {
        assert_eq!(privilege_label(false, true), "insufficient");
        assert_eq!(privilege_label(true, true), "elevated");
        assert_eq!(privilege_label(false, false), "same");
    }

    #[test]
    fn process_name_normalization_ignores_exe_suffix() {
        assert_eq!(
            normalize_process_name("MyGame_x64r.exe"),
            normalize_process_name("MyGame_x64r")
        );
    }
}

