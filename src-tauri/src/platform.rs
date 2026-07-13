use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindow {
    pub hwnd: isize,
    pub title: String,
    pub process_id: u32,
    pub process_name: String,
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub client_left: i32,
    pub client_top: i32,
    pub client_width: u32,
    pub client_height: u32,
    pub elevated: Option<bool>,
    pub ordinal: u32,
    pub display: String,
}

#[derive(Debug, Clone)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureProvider {
    WindowPrint,
    WindowGdi,
    DesktopVisibleGdi,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureReliability {
    HealthVerified,
    TargetWindowUnverified,
    PreviewOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetadata {
    pub provider: CaptureProvider,
    pub reliability: CaptureReliability,
    pub captured_at_ms: u64,
    pub frame_hash: String,
    pub width: u32,
    pub height: u32,
    pub fallback_used: bool,
}

#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub rgb: RgbFrame,
    pub metadata: CaptureMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapturePurpose {
    Control,
    Preview,
}

impl CaptureMetadata {
    pub fn is_strict_target_source(&self) -> bool {
        matches!(
            self.provider,
            CaptureProvider::WindowPrint | CaptureProvider::WindowGdi
        ) && !self.fallback_used
    }

    pub fn permits_control_decision(&self) -> bool {
        self.is_strict_target_source() && self.reliability == CaptureReliability::HealthVerified
    }
}

fn captured_frame(
    rgb: RgbFrame,
    provider: CaptureProvider,
    reliability: CaptureReliability,
    fallback_used: bool,
) -> CapturedFrame {
    let captured_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default();
    let mut hash = 0xcbf29ce484222325u64;
    for byte in &rgb.pixels {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    CapturedFrame {
        metadata: CaptureMetadata {
            provider,
            reliability,
            captured_at_ms,
            frame_hash: format!("fnv1a64:{hash:016x}"),
            width: rgb.width,
            height: rgb.height,
            fallback_used,
        },
        rgb,
    }
}

fn assess_target_frame_health(rgb: &RgbFrame) -> CaptureReliability {
    // Keep assessment self-contained so platform unit tests do not depend on runtime module wiring.
    if rgb.width == 0 || rgb.height == 0 || rgb.pixels.len() < (rgb.width as usize * rgb.height as usize * 3) {
        return CaptureReliability::TargetWindowUnverified;
    }
    let mut min_luma: u8 = 255;
    let mut max_luma: u8 = 0;
    let mut black_pixels: u64 = 0;
    let sample_count = (rgb.width as u64).saturating_mul(rgb.height as u64).max(1);
    for pixel in rgb.pixels.chunks_exact(3) {
        let luma = ((u16::from(pixel[0]) * 30) + (u16::from(pixel[1]) * 59) + (u16::from(pixel[2]) * 11)) / 100;
        let luma = luma.min(255) as u8;
        min_luma = min_luma.min(luma);
        max_luma = max_luma.max(luma);
        if luma <= 8 {
            black_pixels += 1;
        }
    }
    let dynamic_range = max_luma.saturating_sub(min_luma);
    let black_ratio_bps = ((black_pixels.saturating_mul(10_000)) / sample_count).min(10_000);
    if black_ratio_bps >= 9_700 || dynamic_range <= 6 {
        CaptureReliability::TargetWindowUnverified
    } else {
        CaptureReliability::HealthVerified
    }
}

fn capture_with_policy(
    purpose: CapturePurpose,
    providers: &[(CaptureProvider, &dyn Fn() -> Result<RgbFrame, String>)],
    desktop_fallback: impl FnOnce() -> Result<RgbFrame, String>,
) -> Result<CapturedFrame, String> {
    let mut errors: Vec<String> = Vec::new();
    for (provider, capture_fn) in providers {
        match capture_fn() {
            Ok(rgb) => {
                let reliability = assess_target_frame_health(&rgb);
                return Ok(captured_frame(rgb, *provider, reliability, false));
            }
            Err(error) => errors.push(format!("{:?}: {error}", provider)),
        }
    }

    if purpose == CapturePurpose::Control {
        return Err(format!(
            "strict target-window capture unavailable: {}",
            errors.join("; ")
        ));
    }

    desktop_fallback()
        .map(|rgb| {
            captured_frame(
                rgb,
                CaptureProvider::DesktopVisibleGdi,
                CaptureReliability::PreviewOnly,
                true,
            )
        })
        .map_err(|fallback_error| {
            format!(
                "window capture failed: {}; desktop preview fallback failed: {fallback_error}",
                errors.join("; ")
            )
        })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwndPoint {
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwndInputResult {
    pub hwnd: isize,
    pub sent_messages: u32,
    pub detail: String,
}

#[cfg(windows)]
pub fn configure_process_dpi_awareness() {
    windows_impl::configure_process_dpi_awareness();
}

#[cfg(not(windows))]
pub fn configure_process_dpi_awareness() {}

#[cfg(windows)]
pub fn list_windows(title_needle: &str) -> Result<Vec<AppWindow>, String> {
    windows_impl::list_windows(title_needle)
}

#[cfg(not(windows))]
pub fn list_windows(_title_needle: &str) -> Result<Vec<AppWindow>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
pub fn window_for_hwnd(hwnd: isize) -> Result<AppWindow, String> {
    windows_impl::window_for_hwnd(hwnd)
}

#[cfg(not(windows))]
pub fn window_for_hwnd(hwnd: isize) -> Result<AppWindow, String> {
    Err(format!(
        "hwnd window identity is only implemented on Windows: {hwnd}"
    ))
}

#[cfg(windows)]
pub fn capture_client_rgb(hwnd: isize) -> Result<CapturedFrame, String> {
    let print_capture = || windows_impl::capture_client_rgb_print(hwnd);
    let gdi_capture = || windows_impl::capture_client_rgb_primary(hwnd);
    capture_with_policy(
        CapturePurpose::Preview,
        &[
            (CaptureProvider::WindowPrint, &print_capture),
            (CaptureProvider::WindowGdi, &gdi_capture),
        ],
        || windows_impl::capture_client_rgb_fallback(hwnd),
    )
}

#[cfg(not(windows))]
pub fn capture_client_rgb(_hwnd: isize) -> Result<CapturedFrame, String> {
    Err("window capture is only implemented on Windows".to_string())
}

#[cfg(windows)]
pub fn capture_client_rgb_strict(hwnd: isize) -> Result<CapturedFrame, String> {
    let print_capture = || windows_impl::capture_client_rgb_print(hwnd);
    let gdi_capture = || windows_impl::capture_client_rgb_primary(hwnd);
    capture_with_policy(
        CapturePurpose::Control,
        &[
            (CaptureProvider::WindowPrint, &print_capture),
            (CaptureProvider::WindowGdi, &gdi_capture),
        ],
        || windows_impl::capture_client_rgb_fallback(hwnd),
    )
}

#[cfg(not(windows))]
pub fn capture_client_rgb_strict(_hwnd: isize) -> Result<CapturedFrame, String> {
    Err("strict window capture is only implemented on Windows".to_string())
}

#[cfg(windows)]
pub fn current_process_elevated() -> bool {
    windows_impl::current_process_elevated()
}

#[cfg(not(windows))]
pub fn current_process_elevated() -> bool {
    false
}

#[cfg(windows)]
pub fn restart_current_process_as_admin() -> Result<(), String> {
    windows_impl::restart_current_process_as_admin()
}

#[cfg(not(windows))]
pub fn restart_current_process_as_admin() -> Result<(), String> {
    Err("administrator restart is only implemented on Windows".to_string())
}

#[cfg(windows)]
pub fn post_mouse_click(
    hwnd: isize,
    point: HwndPoint,
    button: &str,
) -> Result<HwndInputResult, String> {
    windows_impl::post_mouse_click(hwnd, point, button)
}

#[cfg(windows)]
pub fn post_mouse_double_click(
    hwnd: isize,
    point: HwndPoint,
    button: &str,
) -> Result<HwndInputResult, String> {
    windows_impl::post_mouse_double_click(hwnd, point, button)
}

#[cfg(not(windows))]
pub fn post_mouse_click(
    hwnd: isize,
    _point: HwndPoint,
    _button: &str,
) -> Result<HwndInputResult, String> {
    Err(format!(
        "hwnd mouse input is only implemented on Windows: {hwnd}"
    ))
}

#[cfg(not(windows))]
pub fn post_mouse_double_click(
    hwnd: isize,
    _point: HwndPoint,
    _button: &str,
) -> Result<HwndInputResult, String> {
    Err(format!(
        "hwnd mouse input is only implemented on Windows: {hwnd}"
    ))
}

#[cfg(windows)]
pub fn post_hotkey(hwnd: isize, hotkey: &str) -> Result<HwndInputResult, String> {
    windows_impl::post_hotkey(hwnd, hotkey)
}

#[cfg(not(windows))]
pub fn post_hotkey(hwnd: isize, _hotkey: &str) -> Result<HwndInputResult, String> {
    Err(format!(
        "hwnd keyboard input is only implemented on Windows: {hwnd}"
    ))
}

#[cfg(windows)]
pub fn post_text(hwnd: isize, text: &str) -> Result<HwndInputResult, String> {
    windows_impl::post_text(hwnd, text)
}

#[cfg(not(windows))]
pub fn post_text(hwnd: isize, _text: &str) -> Result<HwndInputResult, String> {
    Err(format!(
        "hwnd text input is only implemented on Windows: {hwnd}"
    ))
}

#[cfg(test)]
mod capture_policy_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn frame(value: u8) -> RgbFrame {
        RgbFrame {
            width: 2,
            height: 2,
            pixels: vec![value; 12],
        }
    }

    fn gradient_frame() -> RgbFrame {
        let mut pixels = Vec::with_capacity(12 * 8 * 3);
        for y in 0..8u32 {
            for x in 0..12u32 {
                let value = ((x * 17 + y * 31) % 200 + 30) as u8;
                pixels.extend_from_slice(&[value, value.saturating_add(20), value.saturating_add(40)]);
            }
        }
        RgbFrame {
            width: 12,
            height: 8,
            pixels,
        }
    }

    #[test]
    fn strict_capture_never_calls_desktop_fallback() {
        let fallback_calls = AtomicUsize::new(0);
        let print_capture = || Err("print failed".to_string());
        let gdi_capture = || Err("window dc failed".to_string());
        let error = capture_with_policy(
            CapturePurpose::Control,
            &[
                (CaptureProvider::WindowPrint, &print_capture),
                (CaptureProvider::WindowGdi, &gdi_capture),
            ],
            || {
                fallback_calls.fetch_add(1, Ordering::SeqCst);
                Ok(frame(1))
            },
        )
        .unwrap_err();

        assert!(error.contains("strict target-window capture unavailable"));
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn preview_fallback_is_explicitly_preview_only() {
        let print_capture = || Err("print failed".to_string());
        let gdi_capture = || Err("window dc failed".to_string());
        let captured = capture_with_policy(
            CapturePurpose::Preview,
            &[
                (CaptureProvider::WindowPrint, &print_capture),
                (CaptureProvider::WindowGdi, &gdi_capture),
            ],
            || Ok(frame(2)),
        )
        .unwrap();

        assert_eq!(
            captured.metadata.provider,
            CaptureProvider::DesktopVisibleGdi
        );
        assert_eq!(
            captured.metadata.reliability,
            CaptureReliability::PreviewOnly
        );
        assert!(captured.metadata.fallback_used);
        assert!(!captured.metadata.is_strict_target_source());
    }

    #[test]
    fn preview_failure_preserves_both_provider_errors() {
        let print_capture = || Err("primary failed".to_string());
        let gdi_capture = || Err("secondary failed".to_string());
        let error = capture_with_policy(
            CapturePurpose::Preview,
            &[
                (CaptureProvider::WindowPrint, &print_capture),
                (CaptureProvider::WindowGdi, &gdi_capture),
            ],
            || Err("fallback failed".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("primary failed"));
        assert!(error.contains("fallback failed"));
    }

    #[test]
    fn strict_capture_metadata_has_source_time_hash_and_dimensions() {
        let print_capture = || Ok(gradient_frame());
        let gdi_capture = || panic!("gdi should not run after successful print capture");
        let captured = capture_with_policy(
            CapturePurpose::Control,
            &[
                (CaptureProvider::WindowPrint, &print_capture),
                (CaptureProvider::WindowGdi, &gdi_capture),
            ],
            || panic!("strict capture must not call fallback"),
        )
        .unwrap();

        assert_eq!(captured.metadata.provider, CaptureProvider::WindowPrint);
        assert_eq!(
            captured.metadata.reliability,
            CaptureReliability::HealthVerified
        );
        assert!(captured.metadata.is_strict_target_source());
        assert!(captured.metadata.permits_control_decision());
        assert_eq!(captured.metadata.width, 12);
        assert_eq!(captured.metadata.height, 8);
        assert!(captured.metadata.captured_at_ms > 0);
        assert!(captured.metadata.frame_hash.starts_with("fnv1a64:"));
    }

    #[test]
    fn black_primary_frame_stays_unverified_for_control() {
        let print_capture = || Ok(frame(0));
        let gdi_capture = || panic!("should not need gdi when print returns a frame");
        let captured = capture_with_policy(
            CapturePurpose::Control,
            &[
                (CaptureProvider::WindowPrint, &print_capture),
                (CaptureProvider::WindowGdi, &gdi_capture),
            ],
            || panic!("strict capture must not call fallback"),
        )
        .unwrap();

        assert_eq!(captured.metadata.provider, CaptureProvider::WindowPrint);
        assert_eq!(
            captured.metadata.reliability,
            CaptureReliability::TargetWindowUnverified
        );
        assert!(!captured.metadata.permits_control_decision());
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::{AppWindow, HwndInputResult, HwndPoint, RgbFrame};
    use std::{
        collections::BTreeMap, ffi::c_void, mem::size_of, os::windows::ffi::OsStrExt, path::PathBuf,
    };
    use windows::{
        core::{BOOL, PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, WPARAM},
            Graphics::{
                Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
                Gdi::{
                    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC,
                    DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BI_RGB,
                    DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
                },
            },
            Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
            System::Threading::{
                GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
                QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE,
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            },
            UI::Shell::ShellExecuteW,
            UI::WindowsAndMessaging::{
                EnumWindows, GetClientRect, GetWindow, GetWindowLongW, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
                IsWindowVisible, PostMessageW, GWL_EXSTYLE, GW_OWNER, SW_SHOWNORMAL,
                WM_CHAR, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MOUSEMOVE, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
                WM_SYSKEYUP, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
            },
        },
    };

    const VK_BACKSPACE: u16 = 0x08;
    const VK_TAB_KEY: u16 = 0x09;
    const VK_RETURN: u16 = 0x0D;
    const VK_SHIFT_KEY: u16 = 0x10;
    const VK_CONTROL_KEY: u16 = 0x11;
    const VK_MENU_KEY: u16 = 0x12;
    const VK_ESCAPE: u16 = 0x1B;
    const VK_SPACE_KEY: u16 = 0x20;
    const VK_F1: u16 = 0x70;
    const MK_LBUTTON_FLAG: u32 = 0x0001;
    const MK_RBUTTON_FLAG: u32 = 0x0002;


    #[link(name = "user32")]
    extern "system" {
        fn PrintWindow(hwnd: HWND, hdc_blt: HDC, n_flags: u32) -> BOOL;
    }

    pub fn configure_process_dpi_awareness() {
        unsafe {
            if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_err() {
                let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
            }
        }
    }

    pub fn list_windows(title_needle: &str) -> Result<Vec<AppWindow>, String> {
        let mut records = Vec::<AppWindow>::new();
        unsafe {
            EnumWindows(
                Some(enum_window_proc),
                LPARAM((&mut records as *mut Vec<AppWindow>) as isize),
            )
            .map_err(|err| err.to_string())?;
        }
        let needle = title_needle.trim().to_lowercase();
        let mut records = records
            .into_iter()
            .filter(|item| needle.is_empty() || item.title.to_lowercase().contains(&needle))
            .filter(|item| !is_control_app_window(item))
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            left.title
                .to_lowercase()
                .cmp(&right.title.to_lowercase())
                .then_with(|| left.hwnd.cmp(&right.hwnd))
        });
        let mut counts = BTreeMap::<String, u32>::new();
        let totals = records
            .iter()
            .fold(BTreeMap::<String, u32>::new(), |mut acc, item| {
                *acc.entry(item.title.clone()).or_default() += 1;
                acc
            });
        for item in &mut records {
            let ordinal = counts
                .entry(item.title.clone())
                .and_modify(|count| *count += 1)
                .or_insert(1);
            item.ordinal = *ordinal;
            item.display = if totals.get(&item.title).copied().unwrap_or_default() > 1 {
                format!("{} #{}", item.title, ordinal)
            } else {
                item.title.clone()
            };
        }
        Ok(records)
    }

    pub fn window_for_hwnd(hwnd: isize) -> Result<AppWindow, String> {
        unsafe {
            let hwnd = checked_hwnd(hwnd)?;
            record_for_window(hwnd).ok_or_else(|| {
                "target window identity is unavailable or no longer eligible".to_string()
            })
        }
    }

    fn is_control_app_window(item: &AppWindow) -> bool {
        item.title.contains("接管台")
            || item
                .process_name
                .eq_ignore_ascii_case("mhxy-shikong-control")
    }

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let records = &mut *(lparam.0 as *mut Vec<AppWindow>);
        if let Some(record) = unsafe { record_for_window(hwnd) } {
            records.push(record);
        }
        true.into()
    }

    unsafe fn record_for_window(hwnd: HWND) -> Option<AppWindow> {
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return None;
        }
        let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        let has_owner = unsafe { GetWindow(hwnd, GW_OWNER) }
            .ok()
            .map(|owner| !owner.0.is_null())
            .unwrap_or(false);
        if has_owner && ex_style & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 || unsafe { is_cloaked(hwnd) } {
            return None;
        }
        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        if process_id == unsafe { GetCurrentProcessId() } {
            return None;
        }
        let title = unsafe { window_title(hwnd) }?;
        if title.is_empty() {
            return None;
        }
        let window_rect = unsafe { window_rect(hwnd) }?;
        let client = unsafe { client_rect_on_screen(hwnd) }?;
        if client.2 < 40 || client.3 < 40 {
            return None;
        }
        Some(AppWindow {
            hwnd: hwnd.0 as isize,
            title,
            process_id,
            process_name: process_name(process_id).unwrap_or_default(),
            left: window_rect.0,
            top: window_rect.1,
            width: window_rect.2,
            height: window_rect.3,
            client_left: client.0,
            client_top: client.1,
            client_width: client.2,
            client_height: client.3,
            elevated: process_elevated(process_id),
            ordinal: 1,
            display: String::new(),
        })
    }

    pub fn capture_client_rgb_print(hwnd: isize) -> Result<RgbFrame, String> {
        unsafe {
            let hwnd = HWND(hwnd as *mut c_void);
            let Some((_, _, width, height)) = client_rect_on_screen(hwnd) else {
                return Err("window client rect unavailable".to_string());
            };
            capture_window_client_print(hwnd, width, height)
        }
    }

    pub fn capture_client_rgb_primary(hwnd: isize) -> Result<RgbFrame, String> {
        unsafe {
            let hwnd = HWND(hwnd as *mut c_void);
            let Some((_, _, width, height)) = client_rect_on_screen(hwnd) else {
                return Err("window client rect unavailable".to_string());
            };
            capture_window_client(hwnd, width, height)
        }
    }

    pub fn capture_client_rgb_fallback(hwnd: isize) -> Result<RgbFrame, String> {
        unsafe {
            let hwnd = HWND(hwnd as *mut c_void);
            let Some((left, top, width, height)) = client_rect_on_screen(hwnd) else {
                return Err("window client rect unavailable".to_string());
            };
            capture_screen_region(left, top, width, height)
        }
    }

    pub fn restart_current_process_as_admin() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let exe = wide_null(exe.as_os_str());
        let verb = wide_null(std::ffi::OsStr::new("runas"));
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(exe.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(format!(
                "ShellExecuteW runas failed: code={}",
                result.0 as isize
            ));
        }
        Ok(())
    }

    pub fn post_mouse_click(
        hwnd: isize,
        point: HwndPoint,
        button: &str,
    ) -> Result<HwndInputResult, String> {
        post_mouse_click_count(hwnd, point, button, 1)
    }

    pub fn post_mouse_double_click(
        hwnd: isize,
        point: HwndPoint,
        button: &str,
    ) -> Result<HwndInputResult, String> {
        post_mouse_click_count(hwnd, point, button, 2)
    }

    fn post_mouse_click_count(
        hwnd: isize,
        point: HwndPoint,
        button: &str,
        click_count: u8,
    ) -> Result<HwndInputResult, String> {
        unsafe {
            let hwnd = checked_hwnd(hwnd)?;
            let (_, _, width, height) = client_rect_on_screen(hwnd)
                .ok_or_else(|| "target client rect unavailable".to_string())?;
            validate_client_point(&point, width, height)?;
            let button = parse_mouse_button(button)?;
            let lparam = point_lparam(point.x, point.y)?;
            let messages = click_messages(button, click_count)?;
            post(hwnd, WM_MOUSEMOVE, WPARAM(0), lparam)?;
            for (message, wparam) in &messages {
                post(hwnd, *message, WPARAM(*wparam as usize), lparam)?;
            }
            let label = if click_count == 2 {
                "double click"
            } else {
                "click"
            };
            Ok(HwndInputResult {
                hwnd: hwnd.0 as isize,
                sent_messages: (messages.len() + 1) as u32,
                detail: format!(
                    "posted {} {} at {},{}",
                    button.label, label, point.x, point.y
                ),
            })
        }
    }

    pub fn post_hotkey(hwnd: isize, hotkey: &str) -> Result<HwndInputResult, String> {
        unsafe {
            let hwnd = checked_hwnd(hwnd)?;
            let keys = parse_hotkey(hotkey)?;
            let has_alt = keys.iter().any(|key| key.vk == VK_MENU_KEY);
            let (down_msg, up_msg) = if has_alt {
                (WM_SYSKEYDOWN, WM_SYSKEYUP)
            } else {
                (WM_KEYDOWN, WM_KEYUP)
            };
            for key in &keys {
                post(hwnd, down_msg, WPARAM(key.vk as usize), LPARAM(1))?;
            }
            for key in keys.iter().rev() {
                post(hwnd, up_msg, WPARAM(key.vk as usize), LPARAM(1))?;
            }
            Ok(HwndInputResult {
                hwnd: hwnd.0 as isize,
                sent_messages: (keys.len() * 2) as u32,
                detail: format!("posted hotkey {}", hotkey.trim()),
            })
        }
    }

    pub fn post_text(hwnd: isize, text: &str) -> Result<HwndInputResult, String> {
        unsafe {
            let hwnd = checked_hwnd(hwnd)?;
            let units = text_message_units(text)?;
            for unit in &units {
                post(hwnd, WM_CHAR, WPARAM(*unit as usize), LPARAM(1))?;
            }
            Ok(HwndInputResult {
                hwnd: hwnd.0 as isize,
                sent_messages: units.len() as u32,
                detail: format!("posted {} text character message(s)", units.len()),
            })
        }
    }

    unsafe fn checked_hwnd(hwnd: isize) -> Result<HWND, String> {
        let hwnd = HWND(hwnd as *mut c_void);
        if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("target hwnd is no longer valid".to_string());
        }
        Ok(hwnd)
    }

    unsafe fn post(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> Result<(), String> {
        unsafe { PostMessageW(Some(hwnd), message, wparam, lparam) }.map_err(|err| err.to_string())
    }

    fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn point_lparam(x: u32, y: u32) -> Result<LPARAM, String> {
        if x > i16::MAX as u32 || y > i16::MAX as u32 {
            return Err(format!("point is outside WM_* coordinate range: {x},{y}"));
        }
        Ok(LPARAM(((y as isize) << 16) | (x as isize & 0xffff)))
    }

    fn validate_client_point(point: &HwndPoint, width: u32, height: u32) -> Result<(), String> {
        if width == 0 || height == 0 {
            return Err("target client rect is empty".to_string());
        }
        if point.x >= width || point.y >= height {
            return Err(format!(
                "point {},{} is outside target client area {}x{}",
                point.x, point.y, width, height
            ));
        }
        Ok(())
    }

    #[derive(Debug, Clone, Copy)]
    struct MouseButton {
        down: u32,
        up: u32,
        double_click: u32,
        wparam: u32,
        label: &'static str,
    }

    fn parse_mouse_button(value: &str) -> Result<MouseButton, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "left" | "l" | "primary" => Ok(MouseButton {
                down: WM_LBUTTONDOWN,
                up: WM_LBUTTONUP,
                double_click: WM_LBUTTONDBLCLK,
                wparam: MK_LBUTTON_FLAG,
                label: "left",
            }),
            "right" | "r" | "secondary" => Ok(MouseButton {
                down: WM_RBUTTONDOWN,
                up: WM_RBUTTONUP,
                double_click: WM_RBUTTONDBLCLK,
                wparam: MK_RBUTTON_FLAG,
                label: "right",
            }),
            other => Err(format!("unsupported mouse button: {other}")),
        }
    }

    fn click_messages(button: MouseButton, click_count: u8) -> Result<Vec<(u32, u32)>, String> {
        match click_count {
            1 => Ok(vec![(button.down, button.wparam), (button.up, 0)]),
            2 => Ok(vec![
                (button.down, button.wparam),
                (button.up, 0),
                (button.double_click, button.wparam),
                (button.up, 0),
            ]),
            other => Err(format!("unsupported mouse click count: {other}")),
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct ParsedKey {
        vk: u16,
    }

    fn parse_hotkey(value: &str) -> Result<Vec<ParsedKey>, String> {
        let keys = value
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(parse_key)
            .collect::<Result<Vec<_>, _>>()?;
        if keys.is_empty() {
            return Err("hotkey is empty".to_string());
        }
        Ok(keys)
    }

    fn text_message_units(value: &str) -> Result<Vec<u16>, String> {
        let text = value.trim();
        if text.is_empty() {
            return Err("text input is empty".to_string());
        }
        Ok(text.encode_utf16().collect())
    }

    fn parse_key(value: &str) -> Result<ParsedKey, String> {
        let upper = value.trim().to_ascii_uppercase();
        let vk = match upper.as_str() {
            "ALT" | "MENU" => VK_MENU_KEY,
            "CTRL" | "CONTROL" => VK_CONTROL_KEY,
            "SHIFT" => VK_SHIFT_KEY,
            "TAB" => VK_TAB_KEY,
            "SPACE" => VK_SPACE_KEY,
            "ESC" | "ESCAPE" => VK_ESCAPE,
            "ENTER" | "RETURN" => VK_RETURN,
            "BACKSPACE" => VK_BACKSPACE,
            key if key.len() == 1 => {
                let byte = key.as_bytes()[0];
                if byte.is_ascii_alphanumeric() {
                    byte as u16
                } else {
                    return Err(format!("unsupported hotkey key: {value}"));
                }
            }
            key if key.starts_with('F') => {
                let number = key[1..]
                    .parse::<u16>()
                    .map_err(|_| format!("unsupported function key: {value}"))?;
                if (1..=24).contains(&number) {
                    VK_F1 + number - 1
                } else {
                    return Err(format!("function key out of range: {value}"));
                }
            }
            _ => return Err(format!("unsupported hotkey key: {value}")),
        };
        Ok(ParsedKey { vk })
    }

    unsafe fn capture_screen_region(
        left: i32,
        top: i32,
        width: u32,
        height: u32,
    ) -> Result<RgbFrame, String> {
        let width_i32 = i32::try_from(width).map_err(|_| "capture width too large".to_string())?;
        let height_i32 =
            i32::try_from(height).map_err(|_| "capture height too large".to_string())?;
        let screen_dc = ScreenDc::new()?;
        capture_from_dc(screen_dc.0, left, top, width, height, width_i32, height_i32)
    }

    unsafe fn capture_window_client_print(
        hwnd: HWND,
        width: u32,
        height: u32,
    ) -> Result<RgbFrame, String> {
        let width_i32 = i32::try_from(width).map_err(|_| "capture width too large".to_string())?;
        let height_i32 =
            i32::try_from(height).map_err(|_| "capture height too large".to_string())?;
        let window_dc = WindowDc::new(hwnd)?;
        let memory_dc = MemoryDc::new(window_dc.dc)?;
        let bitmap = Bitmap::new(window_dc.dc, width_i32, height_i32)?;
        let selected = SelectedObject::new(memory_dc.0, bitmap.as_object())?;
        // PW_CLIENTONLY | PW_RENDERFULLCONTENT
        let printed = PrintWindow(hwnd, memory_dc.0, 3u32);
        if !printed.as_bool() {
            drop(selected);
            return Err("PrintWindow failed".to_string());
        }

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width_i32;
        info.bmiHeader.biHeight = -height_i32;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut bgra = vec![0u8; width as usize * height as usize * 4];
        let scan_lines = GetDIBits(
            memory_dc.0,
            bitmap.0,
            0,
            height,
            Some(bgra.as_mut_ptr().cast::<c_void>()),
            &mut info,
            DIB_RGB_COLORS,
        );
        drop(selected);
        if scan_lines == 0 {
            return Err("GetDIBits failed after PrintWindow".to_string());
        }
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        for pixel in bgra.chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        Ok(RgbFrame {
            width,
            height,
            pixels,
        })
    }

    unsafe fn capture_window_client(
        hwnd: HWND,
        width: u32,
        height: u32,
    ) -> Result<RgbFrame, String> {
        let width_i32 = i32::try_from(width).map_err(|_| "capture width too large".to_string())?;
        let height_i32 =
            i32::try_from(height).map_err(|_| "capture height too large".to_string())?;
        let window_dc = WindowDc::new(hwnd)?;
        capture_from_dc(window_dc.dc, 0, 0, width, height, width_i32, height_i32)
    }

    unsafe fn capture_from_dc(
        source_dc: HDC,
        source_x: i32,
        source_y: i32,
        width: u32,
        height: u32,
        width_i32: i32,
        height_i32: i32,
    ) -> Result<RgbFrame, String> {
        let memory_dc = MemoryDc::new(source_dc)?;
        let bitmap = Bitmap::new(source_dc, width_i32, height_i32)?;
        let selected = SelectedObject::new(memory_dc.0, bitmap.as_object())?;
        BitBlt(
            memory_dc.0,
            0,
            0,
            width_i32,
            height_i32,
            Some(source_dc),
            source_x,
            source_y,
            SRCCOPY,
        )
        .map_err(|err| err.to_string())?;

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width_i32;
        info.bmiHeader.biHeight = -height_i32;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut bgra = vec![0u8; width as usize * height as usize * 4];
        let scan_lines = GetDIBits(
            memory_dc.0,
            bitmap.0,
            0,
            height,
            Some(bgra.as_mut_ptr().cast::<c_void>()),
            &mut info,
            DIB_RGB_COLORS,
        );
        drop(selected);
        if scan_lines == 0 {
            return Err("GetDIBits failed".to_string());
        }
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        for pixel in bgra.chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        Ok(RgbFrame {
            width,
            height,
            pixels,
        })
    }

    unsafe fn client_rect_on_screen(hwnd: HWND) -> Option<(i32, i32, u32, u32)> {
        let mut rect = RECT::default();
        if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
            return None;
        }
        let mut point = POINT { x: 0, y: 0 };
        if !unsafe { ClientToScreen(hwnd, &mut point) }.as_bool() {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        Some((point.x, point.y, width as u32, height as u32))
    }

    unsafe fn window_rect(hwnd: HWND) -> Option<(i32, i32, u32, u32)> {
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        Some((rect.left, rect.top, width as u32, height as u32))
    }

    unsafe fn window_title(hwnd: HWND) -> Option<String> {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if copied <= 0 {
            return None;
        }
        Some(
            String::from_utf16_lossy(&buffer[..copied as usize])
                .trim()
                .to_string(),
        )
    }

    unsafe fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0i32;
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut i32).cast::<c_void>(),
                size_of::<i32>() as u32,
            )
        }
        .is_ok()
            && cloaked != 0
    }

    fn process_name(process_id: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
            let mut buffer = vec![0u16; 32768];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !ok || size == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            PathBuf::from(path)
                .file_stem()
                .map(|item| item.to_string_lossy().to_string())
        }
    }

    pub fn current_process_elevated() -> bool {
        unsafe { token_elevated(GetCurrentProcess()).unwrap_or(false) }
    }

    fn process_elevated(process_id: u32) -> Option<bool> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
            let elevated = token_elevated(handle);
            let _ = CloseHandle(handle);
            elevated
        }
    }

    unsafe fn token_elevated(process_handle: windows::Win32::Foundation::HANDLE) -> Option<bool> {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if unsafe { OpenProcessToken(process_handle, TOKEN_QUERY, &mut token) }.is_err() {
            return None;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast::<c_void>()),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        }
        .is_ok();
        let _ = unsafe { CloseHandle(token) };
        ok.then_some(elevation.TokenIsElevated != 0)
    }

    struct ScreenDc(HDC);
    impl ScreenDc {
        unsafe fn new() -> Result<Self, String> {
            let dc = unsafe { GetDC(None) };
            if dc.is_invalid() {
                Err("GetDC failed".to_string())
            } else {
                Ok(Self(dc))
            }
        }
    }
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(None, self.0);
            }
        }
    }

    struct WindowDc {
        hwnd: HWND,
        dc: HDC,
    }
    impl WindowDc {
        unsafe fn new(hwnd: HWND) -> Result<Self, String> {
            let dc = unsafe { GetDC(Some(hwnd)) };
            if dc.is_invalid() {
                Err("GetDC(hwnd) failed".to_string())
            } else {
                Ok(Self { hwnd, dc })
            }
        }
    }
    impl Drop for WindowDc {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(Some(self.hwnd), self.dc);
            }
        }
    }

    struct MemoryDc(HDC);
    impl MemoryDc {
        unsafe fn new(source: HDC) -> Result<Self, String> {
            let dc = unsafe { CreateCompatibleDC(Some(source)) };
            if dc.is_invalid() {
                Err("CreateCompatibleDC failed".to_string())
            } else {
                Ok(Self(dc))
            }
        }
    }
    impl Drop for MemoryDc {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }

    struct Bitmap(HBITMAP);
    impl Bitmap {
        unsafe fn new(source: HDC, width: i32, height: i32) -> Result<Self, String> {
            let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
            if bitmap.is_invalid() {
                Err("CreateCompatibleBitmap failed".to_string())
            } else {
                Ok(Self(bitmap))
            }
        }

        fn as_object(&self) -> HGDIOBJ {
            self.0.into()
        }
    }
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteObject(self.0.into());
            }
        }
    }

    struct SelectedObject {
        dc: HDC,
        previous: HGDIOBJ,
    }
    impl SelectedObject {
        unsafe fn new(dc: HDC, object: HGDIOBJ) -> Result<Self, String> {
            let previous = unsafe { SelectObject(dc, object) };
            if previous.is_invalid() {
                Err("SelectObject failed".to_string())
            } else {
                Ok(Self { dc, previous })
            }
        }
    }
    impl Drop for SelectedObject {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.dc, self.previous);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn packs_client_point_lparam() {
            let value = point_lparam(12, 34).expect("point should pack");
            assert_eq!(value.0, (34 << 16) | 12);
        }

        #[test]
        fn rejects_point_outside_message_range() {
            assert!(point_lparam(40_000, 10).is_err());
            assert!(point_lparam(10, 40_000).is_err());
        }

        #[test]
        fn validates_client_point_bounds() {
            assert!(validate_client_point(&HwndPoint { x: 0, y: 0 }, 10, 10).is_ok());
            assert!(validate_client_point(&HwndPoint { x: 9, y: 9 }, 10, 10).is_ok());
            assert!(validate_client_point(&HwndPoint { x: 10, y: 9 }, 10, 10).is_err());
            assert!(validate_client_point(&HwndPoint { x: 9, y: 10 }, 10, 10).is_err());
        }

        #[test]
        fn parses_supported_mouse_buttons() {
            let left = parse_mouse_button("left").unwrap();
            let right = parse_mouse_button("right").unwrap();
            assert_eq!(left.label, "left");
            assert_eq!(parse_mouse_button("primary").unwrap().label, "left");
            assert_eq!(right.label, "right");
            assert_eq!(parse_mouse_button("secondary").unwrap().label, "right");
            assert_eq!(left.double_click, WM_LBUTTONDBLCLK);
            assert_eq!(right.double_click, WM_RBUTTONDBLCLK);
            assert!(parse_mouse_button("middle").is_err());
        }

        #[test]
        fn builds_single_and_double_click_messages() {
            let left = parse_mouse_button("left").unwrap();
            let single = click_messages(left, 1).expect("single click messages");
            assert_eq!(
                single,
                vec![(WM_LBUTTONDOWN, MK_LBUTTON_FLAG), (WM_LBUTTONUP, 0)]
            );

            let double = click_messages(left, 2).expect("double click messages");
            assert_eq!(
                double,
                vec![
                    (WM_LBUTTONDOWN, MK_LBUTTON_FLAG),
                    (WM_LBUTTONUP, 0),
                    (WM_LBUTTONDBLCLK, MK_LBUTTON_FLAG),
                    (WM_LBUTTONUP, 0),
                ]
            );
        }

        #[test]
        fn rejects_unsupported_mouse_click_counts() {
            let left = parse_mouse_button("left").unwrap();
            assert!(click_messages(left, 0).is_err());
            assert!(click_messages(left, 3).is_err());
        }

        #[test]
        fn parses_hotkey_sequence() {
            let keys = parse_hotkey("CTRL+SHIFT+1").expect("hotkey should parse");
            assert_eq!(
                keys.iter().map(|key| key.vk).collect::<Vec<_>>(),
                vec![VK_CONTROL_KEY, VK_SHIFT_KEY, b'1' as u16]
            );
        }

        #[test]
        fn rejects_unknown_hotkey_key() {
            assert!(parse_hotkey("ALT+鼠").is_err());
        }

        #[test]
        fn encodes_text_input_as_utf16_messages() {
            let units = text_message_units("你好A").expect("text should encode");
            assert_eq!(units, "你好A".encode_utf16().collect::<Vec<_>>());
        }

        #[test]
        fn rejects_empty_text_input() {
            assert!(text_message_units("   ").is_err());
        }
    }
}
