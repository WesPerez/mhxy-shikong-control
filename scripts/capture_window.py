#!/usr/bin/env python3
"""DPI-aware capture helper for the PC client window.

The Tauri app has the same capture path, but this script is useful while
migrating templates: it can list matching windows, capture the client DC, and
optionally post a single explicit client-coordinate click before capture.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image


SRCCOPY = 0x00CC0020
WHEEL_DELTA = 120
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_MOUSEWHEEL = 0x020A
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001
MAPVK_VSC_TO_VK_EX = 3
CWP_SKIPINVISIBLE = 0x0001
CWP_SKIPDISABLED = 0x0002
SW_RESTORE = 9
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_ELEVATION_CLASS = 20
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4 & ((1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1))
DEFAULT_TITLE = "梦幻西游：时空"
CONTROL_TITLE_MARKERS = ("接管台",)
CONTROL_PROCESS_NAMES = {"mhxy-shikong-control"}


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class TOKEN_ELEVATION(ctypes.Structure):
    _fields_ = [("TokenIsElevated", wintypes.DWORD)]


user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.restype = wintypes.BOOL
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(POINT)]
user32.ClientToScreen.restype = wintypes.BOOL
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.ReleaseDC.restype = ctypes.c_int
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
user32.MapVirtualKeyW.restype = wintypes.UINT
user32.ChildWindowFromPointEx.argtypes = [wintypes.HWND, POINT, wintypes.UINT]
user32.ChildWindowFromPointEx.restype = wintypes.HWND
user32.MapWindowPoints.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.POINTER(POINT),
    wintypes.UINT,
]
user32.MapWindowPoints.restype = ctypes.c_int
if hasattr(user32, "SetProcessDpiAwarenessContext"):
    user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL

kernel32.GetCurrentProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.OpenProcessToken.restype = wintypes.BOOL
advapi32.GetTokenInformation.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    wintypes.LPVOID,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
advapi32.GetTokenInformation.restype = wintypes.BOOL

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.BitBlt.argtypes = [
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.DWORD,
]
gdi32.BitBlt.restype = wintypes.BOOL
gdi32.GetDIBits.argtypes = [
    wintypes.HDC,
    wintypes.HBITMAP,
    wintypes.UINT,
    wintypes.UINT,
    wintypes.LPVOID,
    ctypes.POINTER(BITMAPINFO),
    wintypes.UINT,
]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteObject.restype = wintypes.BOOL
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.DeleteDC.restype = wintypes.BOOL

INPUT_TARGETS: dict[int, int] = {}


def hwnd_value(hwnd: wintypes.HWND | int | None) -> int:
    if hwnd is None:
        return 0
    value = getattr(hwnd, "value", hwnd)
    return int(value or 0)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--index", type=int, default=0, help="0-based index among matching windows")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--focus", action="store_true")
    parser.add_argument("--click", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    set_dpi_awareness()
    current_elevated = current_process_elevated()
    windows = list_windows(args.title)
    if args.list:
        print(
            json.dumps(
                {"currentProcessElevated": current_elevated, "windows": windows},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if not windows:
        raise SystemExit(f"no window title contains: {args.title}")
    if args.index < 0 or args.index >= len(windows):
        raise SystemExit(f"window index {args.index} out of range, found {len(windows)}")

    window = windows[args.index]
    hwnd = wintypes.HWND(window["hwnd"])
    privilege_block = input_privilege_block(current_elevated, window)
    if (args.focus or args.click) and privilege_block:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": privilege_block,
                    "currentProcessElevated": current_elevated,
                    "window": window,
                    "requested": {
                        "focus": bool(args.focus),
                        "click": args.click,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2
    if args.focus:
        try:
            focus_window(hwnd)
        except OSError as error:
            return print_input_error("focus", error, current_elevated, window, args)
        time.sleep(max(0.05, args.delay))
    if args.click:
        try:
            click_client(hwnd, args.click[0], args.click[1])
        except OSError as error:
            return print_input_error("click", error, current_elevated, window, args)
        time.sleep(max(0.05, args.delay))

    image, meta = capture_client(hwnd)
    project_root = args.project_root.resolve()
    output = args.output or (
        project_root
        / "assets/resource/ShiKong/captures"
        / f"window-{time.time_ns()}.png"
    )
    output = output if output.is_absolute() else project_root / output
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    meta.update(window)
    meta["currentProcessElevated"] = current_elevated
    meta["path"] = str(output)
    meta["clicked"] = args.click
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


def input_privilege_block(current_elevated: bool, window: dict[str, object]) -> str | None:
    if window.get("elevated") is True and not current_elevated:
        return (
            "target window is elevated but capture_window.py is not; Windows UIPI "
            "blocks hwnd-targeted focus/click/key messages. Re-run the helper or "
            "the Tauri control app as administrator."
        )
    return None


def print_input_error(
    action: str,
    error: OSError,
    current_elevated: bool,
    window: dict[str, object],
    args: argparse.Namespace,
) -> int:
    print(
        json.dumps(
            {
                "status": "input-error",
                "action": action,
                "error": str(error),
                "winError": getattr(error, "winerror", None),
                "currentProcessElevated": current_elevated,
                "window": window,
                "requested": {
                    "focus": bool(args.focus),
                    "click": args.click,
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 2


def set_dpi_awareness() -> None:
    if hasattr(user32, "SetProcessDpiAwarenessContext"):
        user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)


def list_windows(title_needle: str) -> list[dict[str, object]]:
    needle = title_needle.lower()
    records: list[dict[str, object]] = []

    @EnumWindowsProc
    def callback(hwnd: wintypes.HWND, _lparam: wintypes.LPARAM) -> wintypes.BOOL:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if needle and needle not in title.lower():
            return True
        rect = RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
            return True
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width < 40 or height < 40:
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        process_id = int(pid.value)
        proc_name = process_name(process_id) or ""
        if is_control_app_window(title, proc_name):
            return True
        records.append(
            {
                "hwnd": hwnd_value(hwnd),
                "title": title,
                "processId": process_id,
                "processName": proc_name,
                "elevated": process_elevated(process_id),
                "clientWidth": int(width),
                "clientHeight": int(height),
            }
        )
        return True

    if not user32.EnumWindows(callback, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    records.sort(key=lambda item: (str(item["title"]).lower(), int(item["hwnd"])))
    return records


def is_control_app_window(title: str, process_name_value: str) -> bool:
    if any(marker in title for marker in CONTROL_TITLE_MARKERS):
        return True
    return process_name_value.lower() in CONTROL_PROCESS_NAMES


def focus_window(hwnd: wintypes.HWND) -> None:
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)


def click_client(hwnd: wintypes.HWND, x: int, y: int) -> None:
    post_mouse(hwnd, WM_MOUSEMOVE, 0, x, y)
    time.sleep(0.02)
    post_mouse(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, x, y)
    time.sleep(0.04)
    post_mouse(hwnd, WM_LBUTTONUP, 0, x, y)


def drag_client(
    hwnd: wintypes.HWND,
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    steps: int = 12,
    duration: float = 0.45,
) -> None:
    steps = max(1, int(steps))
    delay = max(0.01, float(duration) / steps)
    post_mouse(hwnd, WM_MOUSEMOVE, 0, start_x, start_y)
    time.sleep(0.02)
    post_mouse(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, start_x, start_y)
    for index in range(1, steps + 1):
        ratio = index / steps
        x = int(round(start_x + (end_x - start_x) * ratio))
        y = int(round(start_y + (end_y - start_y) * ratio))
        time.sleep(delay)
        post_mouse(hwnd, WM_MOUSEMOVE, MK_LBUTTON, x, y)
    time.sleep(0.04)
    post_mouse(hwnd, WM_LBUTTONUP, 0, end_x, end_y)


def wheel_client(hwnd: wintypes.HWND, x: int, y: int, notches: int) -> None:
    point = POINT(x, y)
    if not user32.ClientToScreen(hwnd, ctypes.byref(point)):
        raise ctypes.WinError(ctypes.get_last_error())
    direction = 1 if int(notches) >= 0 else -1
    for _ in range(abs(int(notches))):
        delta = direction * WHEEL_DELTA
        wparam = (delta & 0xFFFF) << 16
        post_message(hwnd, WM_MOUSEWHEEL, wparam, screen_point_lparam(point.x, point.y))
        time.sleep(0.03)


def key_client(hwnd: wintypes.HWND, virtual_key: int) -> None:
    post_message(hwnd, WM_KEYDOWN, int(virtual_key), 1)
    time.sleep(0.04)
    post_message(hwnd, WM_KEYUP, int(virtual_key), (1 | (1 << 30) | (1 << 31)))


def scancodes_client(hwnd: wintypes.HWND, scancodes: list[int]) -> None:
    alt_down = False
    for code in scancodes:
        code = int(code)
        alt_context = alt_down or is_alt_scancode(code)
        post_scancode(hwnd, code, False, alt_context)
        if is_alt_scancode(code):
            alt_down = True
        time.sleep(0.02)
    for code in reversed(scancodes):
        code = int(code)
        alt_context = alt_down or is_alt_scancode(code)
        post_scancode(hwnd, code, True, alt_context)
        if is_alt_scancode(code):
            alt_down = False
        time.sleep(0.02)


def text_client(hwnd: wintypes.HWND, text: str) -> None:
    target_hwnd = remembered_input_target(hwnd)
    encoded = text.encode("utf-16-le")
    for index in range(0, len(encoded), 2):
        data = encoded[index : index + 2]
        post_message(target_hwnd, WM_CHAR, int.from_bytes(data, "little"), 0)
        time.sleep(0.008)


def is_alt_scancode(scancode: int) -> bool:
    return (scancode & 0xFF) == 0x38


def post_scancode(hwnd: wintypes.HWND, scancode: int, key_up: bool, alt_context: bool = False) -> None:
    virtual_key = user32.MapVirtualKeyW(scancode, MAPVK_VSC_TO_VK_EX)
    lparam = 1 | ((scancode & 0xFF) << 16)
    if alt_context:
        lparam |= 1 << 29
    if key_up:
        lparam |= 1 << 30
        lparam |= 1 << 31
    if alt_context:
        message = WM_SYSKEYUP if key_up else WM_SYSKEYDOWN
    else:
        message = WM_KEYUP if key_up else WM_KEYDOWN
    post_message(hwnd, message, virtual_key, lparam)


def post_mouse(hwnd: wintypes.HWND, message: int, wparam: int, x: int, y: int) -> None:
    target_hwnd, target_point = mouse_target_for_client_point(hwnd, x, y)
    if message == WM_LBUTTONDOWN:
        remember_input_target(hwnd, target_hwnd)
    post_message(target_hwnd, message, wparam, client_point_lparam(target_point.x, target_point.y))


def mouse_target_for_client_point(hwnd: wintypes.HWND, x: int, y: int) -> tuple[wintypes.HWND, POINT]:
    target = hwnd
    point = POINT(int(x), int(y))
    for _ in range(8):
        child = user32.ChildWindowFromPointEx(
            target,
            point,
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED,
        )
        if not hwnd_value(child) or hwnd_value(child) == hwnd_value(target):
            break
        user32.MapWindowPoints(target, child, ctypes.byref(point), 1)
        target = child
    return target, point


def remember_input_target(root_hwnd: wintypes.HWND, target_hwnd: wintypes.HWND) -> None:
    root = hwnd_value(root_hwnd)
    target = hwnd_value(target_hwnd)
    if root and target:
        INPUT_TARGETS[root] = target


def remembered_input_target(root_hwnd: wintypes.HWND) -> wintypes.HWND:
    root = hwnd_value(root_hwnd)
    target = INPUT_TARGETS.get(root)
    if not target:
        return root_hwnd
    target_hwnd = wintypes.HWND(target)
    if user32.IsWindow(target_hwnd):
        return target_hwnd
    INPUT_TARGETS.pop(root, None)
    return root_hwnd


def post_message(hwnd: wintypes.HWND, message: int, wparam: int, lparam: int) -> None:
    if not user32.PostMessageW(hwnd, message, wintypes.WPARAM(wparam), wintypes.LPARAM(lparam)):
        raise ctypes.WinError(ctypes.get_last_error())


def client_point_lparam(x: int, y: int) -> int:
    return ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)


def screen_point_lparam(x: int, y: int) -> int:
    return ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)


def capture_client(hwnd: wintypes.HWND) -> tuple[Image.Image, dict[str, object]]:
    rect = RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise RuntimeError("empty client rect")

    source_dc = user32.GetDC(hwnd)
    if not source_dc:
        raise ctypes.WinError(ctypes.get_last_error())
    memory_dc = gdi32.CreateCompatibleDC(source_dc)
    bitmap = gdi32.CreateCompatibleBitmap(source_dc, width, height)
    previous = gdi32.SelectObject(memory_dc, bitmap)
    try:
        if not gdi32.BitBlt(memory_dc, 0, 0, width, height, source_dc, 0, 0, SRCCOPY):
            raise ctypes.WinError(ctypes.get_last_error())
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0
        raw = ctypes.create_string_buffer(width * height * 4)
        lines = gdi32.GetDIBits(memory_dc, bitmap, 0, height, raw, ctypes.byref(info), 0)
        if lines == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        image = Image.frombuffer("RGBA", (width, height), raw, "raw", "BGRA", 0, 1).convert("RGB")
        return image, {"width": int(width), "height": int(height)}
    finally:
        if previous:
            gdi32.SelectObject(memory_dc, previous)
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if memory_dc:
            gdi32.DeleteDC(memory_dc)
        user32.ReleaseDC(hwnd, source_dc)


def current_process_elevated() -> bool | None:
    return token_elevated(kernel32.GetCurrentProcess())


def process_elevated(pid: int) -> bool | None:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        return token_elevated(handle)
    finally:
        kernel32.CloseHandle(handle)


def process_name(pid: int) -> str | None:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        return Path(buffer.value).stem
    finally:
        kernel32.CloseHandle(handle)


def token_elevated(process_handle: wintypes.HANDLE) -> bool | None:
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(process_handle, TOKEN_QUERY, ctypes.byref(token)):
        return None
    try:
        elevation = TOKEN_ELEVATION()
        returned = wintypes.DWORD()
        ok = advapi32.GetTokenInformation(
            token,
            TOKEN_ELEVATION_CLASS,
            ctypes.byref(elevation),
            ctypes.sizeof(elevation),
            ctypes.byref(returned),
        )
        if not ok:
            return None
        return bool(elevation.TokenIsElevated)
    finally:
        kernel32.CloseHandle(token)


if __name__ == "__main__":
    raise SystemExit(main())
