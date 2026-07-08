#!/usr/bin/env python3
"""Capture missing ShiKong inventory item templates by OCR-visible item names.

This helper is for the remaining backpack/material templates whose old Maa
icons cannot be safely matched from generic UI screenshots. It clicks item
slots with hwnd-targeted messages, OCRs the item detail/name that appears after
selection, and can crop the matching slot back into template_mapping.json.

The script never moves the real mouse. If the target game window is elevated
and this process is not, it exits before sending input.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

import capture_window
import rapidocr_bridge


DEFAULT_TITLE = "梦幻西游：时空"
ANCHOR_WIDTH = 763
ANCHOR_HEIGHT = 573
DEFAULT_GRID = {
    "left": 386,
    "top": 151,
    "slot_width": 49,
    "slot_height": 49,
    "stride_x": 51,
    "stride_y": 60,
    "columns": 6,
    "rows": 5,
    "crop_inset": 3,
}

TARGETS: dict[str, list[str]] = {
    "beibao/guoqi.png": ["过期"],
    "beibao/hongluogeng.png": ["红罗羹"],
    "beibao/lvlugeng.png": ["绿芦羹", "绿芦"],
    "beibao/xinmobaozhu.png": ["心魔宝珠"],
    "beibao/zhenfa.png": ["阵法"],
    "mijing_cailiao/bulaogen.png": ["不老根"],
    "mijing_cailiao/chilongjiao.png": ["赤龙角", "螭龙角"],
    "mijing_cailiao/danzhusha.png": ["丹朱砂"],
    "mijing_cailiao/donghuangjiuge.png": ["东皇旧歌", "东皇九歌"],
    "mijing_cailiao/dushengyupo.png": ["独圣玉魄", "独生玉魄", "毒圣玉魄"],
    "mijing_cailiao/jiangmulingzhong.png": ["降魔铃钟", "降魔铃"],
    "mijing_cailiao/jiaorenzhu.png": ["鲛人珠"],
    "mijing_cailiao/jinwuzhi.png": ["金乌枝"],
    "mijing_cailiao/qimingzhiyao.png": ["启明之曜", "启明之耀"],
    "mijing_cailiao/wangchuanshi.png": ["忘川石"],
    "mijing_cailiao/wutongshenmu.png": ["梧桐神木"],
    "mijing_cailiao/xiaochunlan.png": ["晓春兰"],
    "mijing_cailiao/xitianqueling.png": ["西天雀翎"],
    "mijing_cailiao/xuannvlei.png": ["玄女泪"],
    "mijing_cailiao/yinyangcao.png": ["阴阳草"],
    "mijing_cailiao/yueguilu.png": ["月桂露"],
    "mijing_cailiao/zhurongguo.png": ["祝融果"],
}


@dataclass(frozen=True)
class Slot:
    index: int
    row: int
    column: int
    rect: tuple[int, int, int, int]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--target", action="append", default=[], help="Template path to scan. May be repeated.")
    parser.add_argument("--apply", action="store_true", help="Write matched crops and update template_mapping.json.")
    parser.add_argument("--overwrite", action="store_true", help="Allow replacing an existing template mapping.")
    parser.add_argument("--min-score", type=float, default=0.58)
    parser.add_argument("--slot-delay", type=float, default=0.35)
    parser.add_argument("--report-name", default=None)
    parser.add_argument("--save-frames", action="store_true", help="Save full post-click frames for matched slots.")
    parser.add_argument("--grid-left", type=int, default=DEFAULT_GRID["left"])
    parser.add_argument("--grid-top", type=int, default=DEFAULT_GRID["top"])
    parser.add_argument("--slot-width", type=int, default=DEFAULT_GRID["slot_width"])
    parser.add_argument("--slot-height", type=int, default=DEFAULT_GRID["slot_height"])
    parser.add_argument("--stride-x", type=int, default=DEFAULT_GRID["stride_x"])
    parser.add_argument("--stride-y", type=int, default=DEFAULT_GRID["stride_y"])
    parser.add_argument("--columns", type=int, default=DEFAULT_GRID["columns"])
    parser.add_argument("--rows", type=int, default=DEFAULT_GRID["rows"])
    parser.add_argument("--crop-inset", type=int, default=DEFAULT_GRID["crop_inset"])
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    selected_targets = select_targets(args.target)
    capture_window.set_dpi_awareness()
    current_elevated = capture_window.current_process_elevated()
    windows = capture_window.list_windows(args.title)
    if not windows:
        raise SystemExit(f"no window title contains: {args.title}")
    if args.index < 0 or args.index >= len(windows):
        raise SystemExit(f"window index {args.index} out of range, found {len(windows)}")
    window = windows[args.index]
    privilege_block = capture_window.input_privilege_block(current_elevated, window)
    if privilege_block:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": privilege_block,
                    "currentProcessElevated": current_elevated,
                    "window": window,
                    "targets": selected_targets,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    hwnd = capture_window.wintypes.HWND(window["hwnd"])
    first_image, meta = capture_window.capture_client(hwnd)
    width, height = first_image.size
    slots = build_slots(width, height, args)
    run_dir = output_dir(project_root, args.report_name)
    run_dir.mkdir(parents=True, exist_ok=True)
    ocr_engine = rapidocr_bridge.load_engine()

    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = read_json(mapping_path)
    mapping_templates = mapping.setdefault("templates", {})
    if not isinstance(mapping_templates, dict):
        raise RuntimeError(f"{mapping_path} templates must be an object")

    found: dict[str, dict[str, Any]] = {}
    slot_reports: list[dict[str, Any]] = []
    for slot in slots:
        center_x = slot.rect[0] + slot.rect[2] // 2
        center_y = slot.rect[1] + slot.rect[3] // 2
        capture_window.click_client(hwnd, center_x, center_y)
        time.sleep(max(0.05, args.slot_delay))
        image, _slot_meta = capture_window.capture_client(hwnd)
        ocr_rows = recognize_image(ocr_engine, image)
        matched = match_targets(ocr_rows, selected_targets, found.keys(), args.min_score)
        slot_record = {
            "slot": slot_to_json(slot),
            "click": [center_x, center_y],
            "matched": matched,
            "ocrText": " ".join(row.get("text", "") for row in ocr_rows).strip(),
        }
        slot_reports.append(slot_record)
        for match in matched:
            template = match["template"]
            crop_rect = inset_rect(slot.rect, args.crop_inset, width, height)
            crop = crop_image(image, crop_rect)
            crop_path = project_root / "assets/resource/ShiKong/image" / template.replace("/", "\\")
            preview_path = run_dir / safe_file_name(template)
            crop.save(preview_path)
            frame_path = None
            if args.save_frames:
                frame_path = run_dir / f"{safe_stem(template)}-frame.png"
                image.save(frame_path)
            record = {
                "template": template,
                "aliases": TARGETS[template],
                "matchedAlias": match["alias"],
                "score": match["score"],
                "slot": slot_to_json(slot),
                "cropRect": list(crop_rect),
                "previewCrop": str(preview_path),
                "savedFrame": str(frame_path) if frame_path else None,
                "ocrText": slot_record["ocrText"],
            }
            found[template] = record
            if args.apply:
                if template in mapping_templates and not args.overwrite:
                    record["applyStatus"] = "skipped-existing-mapping"
                    continue
                crop_path.parent.mkdir(parents=True, exist_ok=True)
                crop.save(crop_path)
                mapping_templates[template] = {
                    "sourcePipeline": "scripts/capture_inventory_items_by_name.py",
                    "sourceNode": "inventory slot OCR name scan",
                    "sourceRoi": list(crop_rect),
                    "sourceSpace": "inventoryNameScan",
                    "coordinateMode": "client",
                    "sourceImage": relative_or_absolute(project_root, frame_path or preview_path),
                    "sourceFrameWidth": width,
                    "sourceFrameHeight": height,
                    "replacementPath": str(crop_path.relative_to(project_root)).replace("\\", "/"),
                    "width": crop.width,
                    "height": crop.height,
                    "ocrMatchedName": match["alias"],
                    "ocrScore": match["score"],
                    "note": "Captured from a real ShiKong backpack/material grid slot after OCR confirmed the item detail name.",
                }
                record["applyStatus"] = "applied"
        if len(found) == len(selected_targets):
            break

    report = {
        "version": 1,
        "status": "ok",
        "applied": bool(args.apply),
        "projectRoot": str(project_root),
        "window": window,
        "captureMeta": meta,
        "grid": grid_report(width, height, args),
        "targets": selected_targets,
        "found": list(found.values()),
        "missing": [template for template in selected_targets if template not in found],
        "slotReports": slot_reports,
    }
    report_path = run_dir / "inventory-name-scan-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.apply:
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**report, "reportPath": str(report_path)}, ensure_ascii=False, indent=2))
    return 0 if len(found) == len(selected_targets) else 1


def select_targets(values: list[str]) -> list[str]:
    if not values:
        return list(TARGETS)
    selected = []
    for value in values:
        for item in value.split(","):
            template = item.strip().replace("\\", "/")
            if not template:
                continue
            if template not in TARGETS:
                raise SystemExit(f"unknown target template: {template}")
            selected.append(template)
    return list(dict.fromkeys(selected))


def build_slots(width: int, height: int, args: argparse.Namespace) -> list[Slot]:
    sx = width / ANCHOR_WIDTH
    sy = height / ANCHOR_HEIGHT
    left = round(args.grid_left * sx)
    top = round(args.grid_top * sy)
    slot_width = max(1, round(args.slot_width * sx))
    slot_height = max(1, round(args.slot_height * sy))
    stride_x = max(1, round(args.stride_x * sx))
    stride_y = max(1, round(args.stride_y * sy))
    slots = []
    index = 0
    for row in range(max(1, args.rows)):
        for column in range(max(1, args.columns)):
            x = left + column * stride_x
            y = top + row * stride_y
            rect = clamp_rect((x, y, slot_width, slot_height), width, height)
            if rect:
                index += 1
                slots.append(Slot(index=index, row=row + 1, column=column + 1, rect=rect))
    return slots


def grid_report(width: int, height: int, args: argparse.Namespace) -> dict[str, Any]:
    return {
        "anchorWidth": ANCHOR_WIDTH,
        "anchorHeight": ANCHOR_HEIGHT,
        "clientWidth": width,
        "clientHeight": height,
        "left": args.grid_left,
        "top": args.grid_top,
        "slotWidth": args.slot_width,
        "slotHeight": args.slot_height,
        "strideX": args.stride_x,
        "strideY": args.stride_y,
        "columns": args.columns,
        "rows": args.rows,
        "cropInset": args.crop_inset,
    }


def recognize_image(engine: Any, image: Image.Image) -> list[dict[str, Any]]:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        image.save(tmp_path)
        result = rapidocr_bridge.recognize(engine, tmp_path)
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "OCR failed")
        return list(result.get("rows") or [])
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


def match_targets(
    rows: list[dict[str, Any]],
    targets: list[str],
    already_found: Any,
    min_score: float,
) -> list[dict[str, Any]]:
    found_set = set(already_found)
    matches = []
    for row in rows:
        text = normalize_text(str(row.get("text") or ""))
        if not text:
            continue
        score = float(row.get("score") or 0.0)
        if score < min_score:
            continue
        for template in targets:
            if template in found_set:
                continue
            for alias in TARGETS[template]:
                normalized_alias = normalize_text(alias)
                if normalized_alias and normalized_alias in text:
                    matches.append(
                        {
                            "template": template,
                            "alias": alias,
                            "score": score,
                            "text": row.get("text"),
                            "box": row.get("box"),
                        }
                    )
                    found_set.add(template)
                    break
    return matches


def normalize_text(value: str) -> str:
    punctuation = set(" \t\r\n，,。.;；:：!！?？()（）[]【】<>《》\"'“”‘’")
    return "".join(ch for ch in value if ch not in punctuation)


def inset_rect(rect: tuple[int, int, int, int], inset: int, width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    inset = max(0, min(inset, min(w, h) // 3))
    return clamp_rect((x + inset, y + inset, w - 2 * inset, h - 2 * inset), width, height) or rect


def clamp_rect(rect: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int] | None:
    x, y, w, h = rect
    left = max(0, min(width, x))
    top = max(0, min(height, y))
    right = max(0, min(width, x + max(1, w)))
    bottom = max(0, min(height, y + max(1, h)))
    if right <= left or bottom <= top:
        return None
    return (left, top, right - left, bottom - top)


def crop_image(image: Image.Image, rect: tuple[int, int, int, int]) -> Image.Image:
    x, y, w, h = rect
    return image.crop((x, y, x + w, y + h))


def output_dir(project_root: Path, report_name: str | None) -> Path:
    name = report_name or f"inventory-name-scan-{time.time_ns()}"
    return project_root / "assets/resource/ShiKong/crop_plans" / safe_stem(name)


def safe_file_name(template: str) -> str:
    return f"{safe_stem(template)}.png"


def safe_stem(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value.replace("/", "_"))
    return cleaned.strip("_") or "item"


def slot_to_json(slot: Slot) -> dict[str, Any]:
    return {
        "index": slot.index,
        "row": slot.row,
        "column": slot.column,
        "rect": list(slot.rect),
    }


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"version": 1, "templates": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace("\\", "/")
    except ValueError:
        return str(path)


if __name__ == "__main__":
    raise SystemExit(main())
