use serde::Serialize;

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
pub fn capture_client_rgb(hwnd: isize) -> Result<RgbFrame, String> {
    windows_impl::capture_client_rgb(hwnd)
}

#[cfg(not(windows))]
pub fn capture_client_rgb(_hwnd: isize) -> Result<RgbFrame, String> {
    Err("window capture is only implemented on Windows".to_string())
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
mod windows_impl {
    use super::{AppWindow, RgbFrame};
    use std::{
        collections::BTreeMap, ffi::c_void, mem::size_of, os::windows::ffi::OsStrExt, path::PathBuf,
    };
    use windows::{
        core::{BOOL, PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT},
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
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
                GWL_EXSTYLE, GW_OWNER, SW_SHOWNORMAL, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
            },
        },
    };

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

    pub fn capture_client_rgb(hwnd: isize) -> Result<RgbFrame, String> {
        unsafe {
            let hwnd = HWND(hwnd as *mut c_void);
            let Some((left, top, width, height)) = client_rect_on_screen(hwnd) else {
                return Err("window client rect unavailable".to_string());
            };
            capture_window_client(hwnd, width, height)
                .or_else(|_| capture_screen_region(left, top, width, height))
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

    fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
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
    impl std::ops::Deref for WindowDc {
        type Target = HDC;

        fn deref(&self) -> &Self::Target {
            &self.dc
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
}
