#!/usr/bin/env python3
"""Verify one window identity observation with strong process/HWND checks (read-only)."""

from __future__ import print_function

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import execution_progress as progress


VERIFIER_NAME = "window-identity-v1"

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

EnumWindows = user32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
IsWindowVisible = user32.IsWindowVisible
GetWindowTextW = user32.GetWindowTextW
GetWindowTextLengthW = user32.GetWindowTextLengthW
GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetClientRect = user32.GetClientRect
ClientToScreen = user32.ClientToScreen
IsWindow = user32.IsWindow
OpenProcess = kernel32.OpenProcess
CloseHandle = kernel32.CloseHandle
QueryFullProcessImageNameW = kernel32.QueryFullProcessImageNameW

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG), ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def process_is_elevated(pid: int) -> Optional[bool]:
    TOKEN_QUERY = 0x0008
    TokenElevation = 20
    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return None
    try:
        token = wintypes.HANDLE()
        if not ctypes.windll.advapi32.OpenProcessToken(handle, TOKEN_QUERY, ctypes.byref(token)):
            return None
        try:
            elevation = wintypes.DWORD()
            out_size = wintypes.DWORD()
            if not ctypes.windll.advapi32.GetTokenInformation(
                token, TokenElevation, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(out_size)
            ):
                return None
            return bool(elevation.value)
        finally:
            CloseHandle(token)
    finally:
        CloseHandle(handle)


def current_process_elevated() -> bool:
    try:
        import ctypes as ct

        token = wintypes.HANDLE()
        TOKEN_QUERY = 0x0008
        if not ct.windll.advapi32.OpenProcessToken(ct.windll.kernel32.GetCurrentProcess(), TOKEN_QUERY, ct.byref(token)):
            return False
        try:
            elevation = wintypes.DWORD()
            out_size = wintypes.DWORD()
            TokenElevation = 20
            if not ct.windll.advapi32.GetTokenInformation(
                token, TokenElevation, ct.byref(elevation), ct.sizeof(elevation), ct.byref(out_size)
            ):
                return False
            return bool(elevation.value)
        finally:
            CloseHandle(token)
    except Exception:
        return False


def process_image_path(pid: int) -> str:
    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        raise RuntimeError("OpenProcess failed for pid {}".format(pid))
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            raise RuntimeError("QueryFullProcessImageNameW failed for pid {}".format(pid))
        return buf.value
    finally:
        CloseHandle(handle)


def window_title(hwnd: int) -> str:
    length = GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def client_size(hwnd: int) -> Tuple[int, int]:
    rect = RECT()
    if not GetClientRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("GetClientRect failed for hwnd {}".format(hwnd))
    return int(rect.right - rect.left), int(rect.bottom - rect.top)


def find_windows_for_pid(pid: int) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []

    @EnumWindowsProc
    def callback(hwnd, lparam):
        if not IsWindowVisible(hwnd):
            return True
        process_id = wintypes.DWORD()
        GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        if int(process_id.value) != int(pid):
            return True
        title = window_title(hwnd)
        if not title:
            return True
        try:
            width, height = client_size(hwnd)
        except Exception:
            return True
        if width < 40 or height < 40:
            return True
        found.append(
            {
                "hwnd": int(hwnd),
                "pid": int(pid),
                "title": title,
                "clientWidth": width,
                "clientHeight": height,
            }
        )
        return True

    if not EnumWindows(callback, 0):
        raise RuntimeError("EnumWindows failed")
    return found


def privilege_label(controller_elevated: bool, target_elevated: Optional[bool]) -> str:
    if target_elevated is True and not controller_elevated:
        return "insufficient"
    if target_elevated is True and controller_elevated:
        return "elevated"
    if target_elevated is False:
        return "same"
    return "unknown"


def verify_window_identity(
    criterion_id: str,
    command_text: str,
    expected_pid: Optional[int],
    expected_hwnd: Optional[int],
    expected_title_contains: str,
    expected_process_name: str,
    role: str,
) -> Dict[str, Any]:
    # ProgressLock is non-reentrant. Validate criterion under lock, then observe and
    # emit specialized evidence outside so record_evidence can take its own lock.
    with progress.ProgressLock(progress.progress_lock_path()):
        state = progress.load_json(progress.STATE_PATH)
        progress.refresh_state_runtime_fields(state)
        active_criteria = {
            item.get("id"): item for item in state.get("activeSlice", {}).get("acceptanceCriteria", [])
        }
        criterion = active_criteria.get(criterion_id)
        if not criterion or "window_identity" not in criterion.get("requiredEvidenceCategories", []):
            raise RuntimeError("criterion is not an active window_identity acceptance criterion")
        observed_head = (state.get("git") or {}).get("observedHead")
        working_tree_fingerprint = (state.get("git") or {}).get("workingTreeFingerprint")

    if expected_pid is None and expected_hwnd is None:
        raise RuntimeError("either --pid or --hwnd is required")

    if expected_hwnd is not None:
        if not IsWindow(expected_hwnd):
            raise RuntimeError("hwnd {} is not a live window".format(expected_hwnd))
        process_id = wintypes.DWORD()
        GetWindowThreadProcessId(expected_hwnd, ctypes.byref(process_id))
        pid = int(process_id.value)
        if expected_pid is not None and pid != int(expected_pid):
            raise RuntimeError("hwnd pid {} does not match expected pid {}".format(pid, expected_pid))
        title = window_title(expected_hwnd)
        width, height = client_size(expected_hwnd)
        hwnd = int(expected_hwnd)
    else:
        pid = int(expected_pid)
        candidates = find_windows_for_pid(pid)
        if expected_title_contains:
            needle = expected_title_contains.lower()
            candidates = [item for item in candidates if needle in item["title"].lower()]
        if not candidates:
            raise RuntimeError("no visible eligible window found for pid {}".format(pid))
        candidates.sort(key=lambda item: item["clientWidth"] * item["clientHeight"], reverse=True)
        chosen = candidates[0]
        hwnd = int(chosen["hwnd"])
        title = chosen["title"]
        width = int(chosen["clientWidth"])
        height = int(chosen["clientHeight"])

    if expected_title_contains and expected_title_contains.lower() not in title.lower():
        raise RuntimeError(
            "window title {!r} does not contain expected {!r}".format(title, expected_title_contains)
        )

    image_path = process_image_path(pid)
    process_name = Path(image_path).name
    if expected_process_name and process_name.lower() != expected_process_name.lower():
        raise RuntimeError(
            "process name {!r} does not match expected {!r}".format(process_name, expected_process_name)
        )

    controller_elevated = current_process_elevated()
    target_elevated = process_is_elevated(pid)
    privilege = privilege_label(controller_elevated, target_elevated)
    target_identity = "{}:{}@{}:{}".format(role, pid, process_name, hwnd)

    report_dir = (
        progress.ROOT
        / "assets"
        / "resource"
        / "ShiKong"
        / "reports"
        / "dev-progress"
        / "window-identity-{}".format(criterion_id)
    )
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "identity-report.json"
    verification = {
        "verifier": VERIFIER_NAME,
        "role": role,
        "hwnd": hwnd,
        "pid": pid,
        "title": title,
        "processName": process_name,
        "exePath": image_path,
        "clientWidth": width,
        "clientHeight": height,
        "privilege": privilege,
        "controllerElevated": controller_elevated,
        "targetElevated": target_elevated,
        "targetIdentity": target_identity,
        "observedHead": observed_head,
        "workingTreeFingerprint": working_tree_fingerprint,
        "readOnly": True,
        "inputSent": False,
    }
    report_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    evidence_args = argparse.Namespace(
        id=None,
        category="window_identity",
        claim="Verified live window identity for {} (read-only, no input)".format(role),
        status="passed",
        command=command_text,
        target_identity=target_identity,
        window_evidence_id=None,
        window_hwnd=hwnd,
        window_pid=pid,
        window_title=title,
        window_process=process_name,
        client_width=width,
        client_height=height,
        privilege=privilege,
        exit_code=0,
        criterion=[criterion_id],
        artifact=[str(report_path.relative_to(progress.ROOT)).replace("\\", "/")],
        input_sent=False,
        foreground_unchanged=None,
        cursor_unchanged=None,
        window_identity_verified=True,
        postcondition_observed=True,
        capture_method="specialized_verifier",
        runner_profile=None,
        verifier=VERIFIER_NAME,
        verification=verification,
    )
    evidence_id = progress.record_evidence(evidence_args, allow_passed=True)
    return {
        "evidenceId": evidence_id,
        "targetIdentity": target_identity,
        "hwnd": hwnd,
        "pid": pid,
        "reportPath": str(report_path),
        "privilege": privilege,
    }



def main(argv: Optional[List[str]] = None) -> int:
    if os.name != "nt":
        raise RuntimeError("window identity verifier requires Windows")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criterion", required=True)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--hwnd", type=int)
    parser.add_argument("--title-contains", default="")
    parser.add_argument("--process-name", default="")
    parser.add_argument("--role", default="window")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    command_text = "python -B scripts/verify_window_identity.py --criterion {}".format(args.criterion)
    if args.pid is not None:
        command_text += " --pid {}".format(args.pid)
    if args.hwnd is not None:
        command_text += " --hwnd {}".format(args.hwnd)
    if args.title_contains:
        command_text += " --title-contains {}".format(args.title_contains)
    if args.process_name:
        command_text += " --process-name {}".format(args.process_name)
    if args.role:
        command_text += " --role {}".format(args.role)
    result = verify_window_identity(
        args.criterion,
        command_text,
        args.pid,
        args.hwnd,
        args.title_contains,
        args.process_name,
        args.role,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["evidenceId"])
        print(result["targetIdentity"])
        print("hwnd={}".format(result["hwnd"]))
        print(result["reportPath"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("window identity verification failed: {}".format(exc), file=sys.stderr)
        sys.exit(1)