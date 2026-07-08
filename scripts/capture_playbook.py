#!/usr/bin/env python3
"""Run a repeatable screenshot capture playbook against the ShiKong PC client.

The helper is designed for the template migration phase. It can focus one
`梦幻西游：时空` window, post explicit client-coordinate actions, capture
each requested state, and write a manifest that can feed probe/triage tools.

If the game is elevated, run this script from an elevated terminal. Input is
sent with hwnd-targeted window messages instead of moving the real system
cursor, but Windows still blocks lower-integrity processes from controlling an
elevated game window.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import capture_window


DEFAULT_PLAYBOOK = Path("assets/resource/ShiKong/capture_playbooks/main-panels.json")
DEFAULT_TITLE = "梦幻西游：时空"
PLUS_MENU_TEMPLATE = Path("assets/resource/ShiKong/image/zonghe/chenghao.png")
PLUS_MENU_MATCH_THRESHOLD = 0.82
CHAT_COLLAPSE_TEMPLATE = Path("assets/resource/ShiKong/image/qiandao/liaotian_guanbi.png")
CHAT_COLLAPSE_MATCH_THRESHOLD = 0.88
VK_CODES = {
    "ESC": 0x1B,
    "ENTER": 0x0D,
    "SPACE": 0x20,
    "TAB": 0x09,
    "F1": 0x70,
    "F2": 0x71,
    "F3": 0x72,
    "F4": 0x73,
    "F5": 0x74,
    "F6": 0x75,
    "F7": 0x76,
    "F8": 0x77,
    "F9": 0x78,
    "F10": 0x79,
    "F11": 0x7A,
    "F12": 0x7B,
}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--playbook", type=Path, default=DEFAULT_PLAYBOOK)
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--step", action="append", default=[], help="run only named step(s)")
    parser.add_argument("--from-step", default=None, help="start from this named step when --step is not used")
    parser.add_argument("--until-step", default=None, help="stop after this named step when --step is not used")
    parser.add_argument("--list-steps", action="store_true", help="print playbook steps and exit")
    parser.add_argument("--continue-on-error", action="store_true", help="keep running later steps after a step fails")
    parser.add_argument("--no-error-capture", action="store_true", help="do not save a current screenshot after a failed step")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--allow-unelevated-input",
        action="store_true",
        help="attempt input even when the target window is elevated and this process is not",
    )
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    playbook_path = resolve(project_root, args.playbook)
    playbook = json.loads(playbook_path.read_text(encoding="utf-8"))
    steps = select_steps(playbook, args.step, args.from_step, args.until_step)
    before_each = action_list(playbook.get("beforeEach"))
    selected_steps = {step_name(step) for step in steps}
    if args.list_steps:
        print(json.dumps(build_step_listing(playbook, steps), ensure_ascii=False, indent=2))
        return 0

    capture_window.set_dpi_awareness()
    current_elevated = capture_window.current_process_elevated()
    windows = capture_window.list_windows(args.title)
    if not windows:
        raise SystemExit(f"no window title contains: {args.title}")
    if args.index < 0 or args.index >= len(windows):
        raise SystemExit(f"window index {args.index} out of range, found {len(windows)}")
    window = windows[args.index]
    hwnd = capture_window.wintypes.HWND(window["hwnd"])
    has_input = steps_have_input(steps, before_each)
    if (
        has_input
        and not args.dry_run
        and window.get("elevated") is True
        and current_elevated is False
        and not args.allow_unelevated_input
    ):
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": (
                        "target game is elevated but this process is not; run from an elevated "
                        "terminal or use npm run capture:playbook:admin"
                    ),
                    "currentProcessElevated": current_elevated,
                    "window": window,
                    "playbook": relative_or_absolute(project_root, playbook_path),
                    "selectedSteps": [step_name(step) for step in steps],
                    "hasInput": has_input,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    output_dir = args.output_dir or (
        project_root
        / "assets/resource/ShiKong/captures"
        / f"playbook-{safe_name(playbook.get('name') or 'capture')}-{time.time_ns()}"
    )
    output_dir = resolve(project_root, output_dir)
    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "version": 1,
        "playbook": relative_or_absolute(project_root, playbook_path),
        "generatedAt": int(time.time()),
        "dryRun": args.dry_run,
        "currentProcessElevated": current_elevated,
        "window": window,
        "outputDir": str(output_dir),
        "selectedSteps": [step_name(step) for step in steps],
        "continueOnError": args.continue_on_error,
        "captures": [],
    }

    for step in steps:
        try:
            result = run_step(
                project_root,
                output_dir,
                hwnd,
                window,
                step,
                before_each,
                args.dry_run,
            )
        except Exception as exc:
            if not args.continue_on_error:
                raise
            result = error_record(
                project_root,
                output_dir,
                hwnd,
                step,
                exc,
                args.dry_run,
                capture_on_error=not args.no_error_capture,
            )
        manifest["captures"].append(result)

    if not args.dry_run:
        manifest_path = output_dir / "capture-manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest["manifestPath"] = str(manifest_path)

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def run_step(
    project_root: Path,
    output_dir: Path,
    hwnd: Any,
    window: dict[str, Any],
    step: dict[str, Any],
    before_each: list[Any],
    dry_run: bool,
) -> dict[str, Any]:
    name = str(step.get("name") or "step")
    wait_before = float(step.get("waitBefore") or 0)
    wait_after = float(step.get("waitAfter") or step.get("wait") or 0.25)
    actions = action_list(step.get("actions"))
    after_actions = action_list(step.get("after"))
    record: dict[str, Any] = {
        "name": name,
        "note": step.get("note"),
        "beforeEach": before_each,
        "actions": actions,
        "after": after_actions,
        "status": "dry-run" if dry_run else "ok",
        "path": None,
        "width": None,
        "height": None,
    }
    if dry_run:
        return record

    sleep(wait_before)
    for action in before_each:
        run_action(project_root, hwnd, window, action)
    for action in actions:
        run_action(project_root, hwnd, window, action)
    sleep(wait_after)
    if step.get("capture", True):
        image, meta = capture_window.capture_client(hwnd)
        path = output_dir / f"{safe_name(name)}.png"
        image.save(path)
        record.update(
            {
                "path": relative_or_absolute(project_root, path),
                "width": meta["width"],
                "height": meta["height"],
            }
        )
    for action in after_actions:
        run_action(project_root, hwnd, window, action)
    sleep(float(step.get("afterWait") or 0.15))
    return record


def error_record(
    project_root: Path,
    output_dir: Path,
    hwnd: Any,
    step: dict[str, Any],
    exc: Exception,
    dry_run: bool,
    capture_on_error: bool,
) -> dict[str, Any]:
    name = step_name(step)
    record: dict[str, Any] = {
        "name": name,
        "note": step.get("note"),
        "actions": step.get("actions") or [],
        "after": step.get("after") or [],
        "status": "error",
        "error": f"{type(exc).__name__}: {exc}",
        "path": None,
        "width": None,
        "height": None,
    }
    if dry_run or not capture_on_error:
        return record
    try:
        image, meta = capture_window.capture_client(hwnd)
        path = output_dir / f"{safe_name(name)}-error.png"
        image.save(path)
        record.update(
            {
                "path": relative_or_absolute(project_root, path),
                "width": meta["width"],
                "height": meta["height"],
                "errorCapture": True,
            }
        )
    except Exception as capture_exc:
        record["errorCapture"] = False
        record["errorCaptureError"] = f"{type(capture_exc).__name__}: {capture_exc}"
    return record


def run_action(project_root: Path, hwnd: Any, window: dict[str, Any], action: Any) -> None:
    if not isinstance(action, dict):
        return
    if "click" in action:
        x, y = client_point(action["click"], int(window["clientWidth"]), int(window["clientHeight"]))
        capture_window.click_client(hwnd, x, y)
        sleep(float(action.get("wait") or 0.15))
    elif "drag" in action:
        points = action["drag"]
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError(f"drag must be [[x1,y1],[x2,y2]], got {points!r}")
        start_x, start_y = client_point(points[0], int(window["clientWidth"]), int(window["clientHeight"]))
        end_x, end_y = client_point(points[1], int(window["clientWidth"]), int(window["clientHeight"]))
        capture_window.drag_client(
            hwnd,
            start_x,
            start_y,
            end_x,
            end_y,
            int(action.get("steps") or 12),
            float(action.get("duration") or 0.45),
        )
        sleep(float(action.get("wait") or 0.15))
    elif "wheel" in action:
        at = action.get("at") or [0.5, 0.5]
        x, y = client_point(at, int(window["clientWidth"]), int(window["clientHeight"]))
        capture_window.wheel_client(hwnd, x, y, int(action["wheel"]))
        sleep(float(action.get("wait") or 0.15))
    elif action.get("closePanel"):
        close_panel(hwnd)
        sleep(float(action.get("wait") or 0.15))
    elif action.get("ensurePlusExpanded"):
        ensure_plus_expanded(project_root, hwnd, window)
        sleep(float(action.get("wait") or 0.15))
    elif action.get("collapsePlusMenu"):
        collapse_plus_menu(project_root, hwnd, window)
        sleep(float(action.get("wait") or 0.15))
    elif "scancode" in action:
        press_scancodes(hwnd, action["scancode"])
        sleep(float(action.get("wait") or 0.15))
    elif "key" in action:
        press_key(hwnd, str(action["key"]))
        sleep(float(action.get("wait") or 0.15))
    elif "wait" in action:
        sleep(float(action["wait"]))


def client_point(value: Any, width: int, height: int) -> tuple[int, int]:
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError(f"click must be [x,y] or normalized [rx,ry], got {value!r}")
    x_raw = float(value[0])
    y_raw = float(value[1])
    x = int(round(x_raw * width)) if 0.0 <= x_raw <= 1.0 else int(round(x_raw))
    y = int(round(y_raw * height)) if 0.0 <= y_raw <= 1.0 else int(round(y_raw))
    return max(0, min(width - 1, x)), max(0, min(height - 1, y))


def close_panel(hwnd: Any) -> None:
    image, _meta = capture_window.capture_client(hwnd)
    if not has_panel_surface(image):
        target = find_chat_collapse_button(image)
        if target:
            capture_window.click_client(hwnd, target[0], target[1])
        return
    target = find_close_button(image)
    if target:
        capture_window.click_client(hwnd, target[0], target[1])
        return
    target = find_chat_collapse_button(image)
    if target:
        capture_window.click_client(hwnd, target[0], target[1])


def ensure_plus_expanded(project_root: Path, hwnd: Any, window: dict[str, Any]) -> None:
    if plus_menu_expanded(project_root, hwnd):
        return
    x, y = client_point([0.97, 0.945], int(window["clientWidth"]), int(window["clientHeight"]))
    capture_window.click_client(hwnd, x, y)


def collapse_plus_menu(project_root: Path, hwnd: Any, window: dict[str, Any]) -> None:
    if not plus_menu_expanded(project_root, hwnd):
        return
    x, y = client_point([0.97, 0.945], int(window["clientWidth"]), int(window["clientHeight"]))
    capture_window.click_client(hwnd, x, y)


def plus_menu_expanded(project_root: Path, hwnd: Any) -> bool:
    template_path = resolve(project_root, PLUS_MENU_TEMPLATE)
    template = cv2.imread(str(template_path), cv2.IMREAD_GRAYSCALE)
    if template is None:
        return False
    image, _meta = capture_window.capture_client(hwnd)
    gray = np.array(image.convert("L"))
    height, width = gray.shape[:2]
    template_height, template_width = template.shape[:2]
    left = int(width * 0.84)
    top = int(height * 0.76)
    roi = gray[top:height, left:width]
    if roi.shape[0] < template_height or roi.shape[1] < template_width:
        return False
    result = cv2.matchTemplate(roi, template, cv2.TM_CCOEFF_NORMED)
    _min_value, max_value, _min_location, _max_location = cv2.minMaxLoc(result)
    return max_value >= PLUS_MENU_MATCH_THRESHOLD


def has_panel_surface(image: Any) -> bool:
    width, height = image.size
    pixels = image.convert("RGB").load()
    min_x = int(width * 0.18)
    max_x = int(width * 0.96)
    min_y = int(height * 0.08)
    max_y = int(height * 0.92)
    area = (max_x - min_x) * (max_y - min_y)
    if area <= 0:
        return False
    count = 0
    for y in range(min_y, max_y, 2):
        for x in range(min_x, max_x, 2):
            if is_panel_surface_pixel(pixels[x, y]):
                count += 4
    return count / area >= 0.20


def is_panel_surface_pixel(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    return (
        red >= 145
        and green >= 105
        and blue >= 65
        and red - blue >= 15
        and red - green <= 90
        and max(pixel) - min(pixel) <= 150
    )


def find_close_button(image: Any) -> tuple[int, int] | None:
    width, height = image.size
    pixels = image.convert("RGB").load()
    max_x = int(width * 0.96)
    min_y = 64
    max_y = int(height * 0.28)

    def collect(scan_min_x: int) -> list[tuple[float, int, int, int]]:
        visited: set[tuple[int, int]] = set()
        found: list[tuple[float, int, int, int]] = []
        for y in range(min_y, max_y):
            for x in range(scan_min_x, max_x):
                if (x, y) in visited or not is_close_red(pixels[x, y]):
                    continue
                stack = [(x, y)]
                visited.add((x, y))
                xs: list[int] = []
                ys: list[int] = []
                while stack:
                    px, py = stack.pop()
                    xs.append(px)
                    ys.append(py)
                    for nx, ny in ((px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)):
                        if (
                            nx < scan_min_x
                            or nx >= max_x
                            or ny < min_y
                            or ny >= max_y
                            or (nx, ny) in visited
                            or not is_close_red(pixels[nx, ny])
                        ):
                            continue
                        visited.add((nx, ny))
                        stack.append((nx, ny))
                area = len(xs)
                box_w = max(xs) - min(xs) + 1
                box_h = max(ys) - min(ys) + 1
                if area < 20 or box_w < 12 or box_h < 8 or box_w > 100 or box_h > 80:
                    continue
                if box_w > box_h * 2.2:
                    continue
                center_y = int(round((min(ys) + max(ys)) / 2))
                target_x = max(xs) - 15 if box_w > 45 else int(round((min(xs) + max(xs)) / 2))
                score = target_x * 4.0 - center_y * 8.0 + area * 0.05
                found.append((score, target_x, center_y, area))
        return found

    candidates = collect(int(width * 0.86))
    if candidates:
        glyph_candidates = [item for item in candidates if item[3] <= 500]
        if glyph_candidates:
            _score, target_x, center_y, _area = max(glyph_candidates, key=lambda item: item[0])
            return target_x, center_y
        modal_candidates = [item for item in candidates if item[2] >= int(height * 0.20)]
        _score, target_x, center_y, _area = max(modal_candidates or candidates, key=lambda item: (item[2], item[1], item[3]))
        return target_x, center_y

    candidates = collect(int(width * 0.65))
    if not candidates:
        return None
    glyph_candidates = [item for item in candidates if item[3] <= 500]
    _score, target_x, center_y, _area = max(glyph_candidates or candidates, key=lambda item: item[0])
    return target_x, center_y


def find_chat_collapse_button(image: Any) -> tuple[int, int] | None:
    template_path = CHAT_COLLAPSE_TEMPLATE
    if not template_path.is_absolute():
        template_path = Path.cwd() / template_path
    template = cv2.imread(str(template_path), cv2.IMREAD_GRAYSCALE)
    if template is None:
        return None
    gray = np.array(image.convert("L"))
    height, width = gray.shape[:2]
    template_height, template_width = template.shape[:2]
    left = int(width * 0.40)
    right = int(width * 0.58)
    top = int(height * 0.34)
    bottom = int(height * 0.62)
    roi = gray[top:bottom, left:right]
    if roi.shape[0] < template_height or roi.shape[1] < template_width:
        return None
    result = cv2.matchTemplate(roi, template, cv2.TM_CCOEFF_NORMED)
    _min_value, max_value, _min_location, max_location = cv2.minMaxLoc(result)
    if max_value < CHAT_COLLAPSE_MATCH_THRESHOLD:
        return None
    return left + max_location[0] + template_width // 2, top + max_location[1] + template_height // 2


def is_close_red(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    red_close = red >= 175 and green <= 120 and blue <= 95 and red > green + 55 and red > blue + 55
    orange_close = red >= 190 and 80 <= green <= 220 and blue <= 150 and red > blue + 60 and green > blue + 15
    return red_close or orange_close


def press_key(hwnd: Any, name: str) -> None:
    code = key_code(name)
    capture_window.key_client(hwnd, code)


def press_scancodes(hwnd: Any, value: Any) -> None:
    codes = value if isinstance(value, list) else [value]
    parsed = [int(code) for code in codes]
    capture_window.scancodes_client(hwnd, parsed)


def key_code(name: str) -> int:
    text = name.strip().upper()
    if text in VK_CODES:
        return VK_CODES[text]
    if text.startswith("0X"):
        return int(text, 16)
    if text.isdigit():
        return int(text)
    if len(text) == 1:
        return ord(text)
    raise ValueError(f"unknown key: {name}")


def action_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def steps_have_input(steps: list[dict[str, Any]], before_each: list[Any]) -> bool:
    for step in steps:
        actions = before_each + action_list(step.get("actions")) + action_list(step.get("after"))
        for action in actions:
            if isinstance(action, dict) and (
                "click" in action
                or "drag" in action
                or "wheel" in action
                or "key" in action
                or "scancode" in action
                or action.get("closePanel")
                or action.get("ensurePlusExpanded")
                or action.get("collapsePlusMenu")
            ):
                return True
    return False


def select_steps(
    playbook: dict[str, Any],
    explicit_steps: list[str],
    from_step: str | None,
    until_step: str | None,
) -> list[dict[str, Any]]:
    steps = [step for step in playbook.get("steps") or [] if isinstance(step, dict)]
    names = [step_name(step) for step in steps]
    name_set = set(names)
    for name in list(explicit_steps) + [item for item in [from_step, until_step] if item]:
        if name not in name_set:
            raise SystemExit(f"unknown playbook step: {name}; known steps: {', '.join(names)}")
    if explicit_steps and (from_step or until_step):
        raise SystemExit("--step cannot be combined with --from-step or --until-step")
    if explicit_steps:
        selected = set(explicit_steps)
        return [step for step in steps if step_name(step) in selected]
    start = names.index(from_step) if from_step else 0
    end = names.index(until_step) if until_step else len(steps) - 1
    if start > end:
        raise SystemExit("--from-step must appear before --until-step in the playbook")
    return steps[start : end + 1]


def build_step_listing(playbook: dict[str, Any], selected_steps: list[dict[str, Any]]) -> dict[str, Any]:
    selected = {step_name(step) for step in selected_steps}
    before_each = action_list(playbook.get("beforeEach"))
    rows = []
    for index, step in enumerate([item for item in playbook.get("steps") or [] if isinstance(item, dict)], start=1):
        actions = before_each + action_list(step.get("actions")) + action_list(step.get("after"))
        rows.append(
            {
                "index": index,
                "name": step_name(step),
                "selected": step_name(step) in selected,
                "capture": bool(step.get("capture", True)),
                "inputActions": sum(1 for action in actions if is_input_action(action)),
                "note": step.get("note"),
            }
        )
    return {
        "playbook": playbook.get("name"),
        "title": playbook.get("title"),
        "beforeEachInputActions": sum(1 for action in before_each if is_input_action(action)),
        "steps": rows,
    }


def is_input_action(action: Any) -> bool:
    return isinstance(action, dict) and (
        "click" in action
        or "drag" in action
        or "wheel" in action
        or "key" in action
        or "scancode" in action
        or action.get("closePanel")
        or action.get("ensurePlusExpanded")
        or action.get("collapsePlusMenu")
    )


def step_name(step: dict[str, Any]) -> str:
    return str(step.get("name") or "step")


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def safe_name(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value)
    return cleaned.strip("_") or "capture"


def sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


if __name__ == "__main__":
    raise SystemExit(main())
