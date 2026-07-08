#!/usr/bin/env python3
"""Suggest ShiKong template crops by matching old Maa templates in a reference image.

The script is intentionally conservative:
- By default it only writes a JSON report under assets/resource/ShiKong/crop_plans.
- It writes replacement images only with --apply.
- Existing mappings are skipped unless --overwrite is provided.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw


BASELINE_WIDTH = 1280
BASELINE_HEIGHT = 720
VISIBLE_4X3_LEFT = 160
VISIBLE_4X3_WIDTH = 960
DEFAULT_SCALES = [0.75, 0.85, 0.95, 1.0, 1.1, 1.2, 1.35, 1.5, 1.7]


@dataclass
class TemplateContext:
    template: str
    pipeline: str
    node: str
    roi: list[int] | None


@dataclass
class Suggestion:
    template: str
    score: float
    roi: list[int]
    scale: float
    old_size: list[int]
    new_size: list[int]
    source_path: str
    already_mapped: bool
    pipeline: str | None = None
    node: str | None = None
    source_roi: list[int] | None = None
    search_roi: list[int] | None = None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument(
        "--reference",
        type=Path,
        default=Path("assets/resource/ShiKong/captures/reference-image-1.png"),
    )
    parser.add_argument("--domain", action="append", default=[])
    parser.add_argument("--template", action="append", default=[])
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--min-score", type=float, default=0.62)
    parser.add_argument(
        "--roi-aware",
        action="store_true",
        help="search only mapped Maa ROI regions when a template has ROI contexts",
    )
    parser.add_argument(
        "--coordinate-mode",
        choices=["cropCenter4x3", "stretch1280x720"],
        default="cropCenter4x3",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--apply-threshold", type=float, default=0.88)
    parser.add_argument(
        "--append-variant",
        action="store_true",
        help="when applying an already mapped template, append a variant instead of overwriting",
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--preview-limit", type=int, default=40)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    reference_path = resolve(project_root, args.reference)
    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = load_mapping(mapping_path)
    mapped = set(mapping.get("templates", {}).keys())

    reference_rgb = cv2.cvtColor(np.array(Image.open(reference_path).convert("RGB")), cv2.COLOR_RGB2BGR)
    reference_gray = cv2.cvtColor(reference_rgb, cv2.COLOR_BGR2GRAY)

    template_contexts = collect_template_contexts(maa_root)
    if args.template:
        wanted = {slash_path(Path(item)) for item in args.template}
        template_contexts = [item for item in template_contexts if item.template in wanted]
    if args.domain:
        domains = set(args.domain)
        template_contexts = [
            item for item in template_contexts if item.template.split("/", 1)[0] in domains
        ]
    contexts_by_template: dict[str, list[TemplateContext]] = {}
    for context in template_contexts:
        contexts_by_template.setdefault(context.template, []).append(context)

    suggestions: list[Suggestion] = []
    image_root = maa_root / "assets/resource/base/image"
    for template_ref, contexts in sorted(contexts_by_template.items()):
        if template_ref in mapped and not args.overwrite and not args.append_variant:
            continue
        source_path = image_root / template_ref
        if not source_path.is_file() or source_path.stat().st_size < 16:
            continue
        search_contexts = contexts if args.roi_aware else [TemplateContext(template_ref, "", "", None)]
        suggestion = suggest_one(
            template_ref,
            source_path,
            reference_gray,
            reference_rgb.shape[1],
            reference_rgb.shape[0],
            template_ref in mapped,
            search_contexts,
            args.coordinate_mode,
        )
        if suggestion and suggestion.score >= args.min_score:
            suggestions.append(suggestion)

    suggestions.sort(key=lambda item: (-item.score, item.template))
    suggestions = suggestions[: max(1, args.limit)]

    report_path = args.report or (
        project_root
        / "assets/resource/ShiKong/crop_plans"
        / f"template-suggestions-{time.time_ns()}.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "version": 1,
        "referenceImage": slash_path(reference_path.relative_to(project_root)),
        "maaRoot": str(maa_root),
        "generatedAt": int(time.time()),
        "minScore": args.min_score,
        "roiAware": args.roi_aware,
        "coordinateMode": args.coordinate_mode,
        "items": [item.__dict__ for item in suggestions],
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    preview_paths: list[Path] = []
    if args.preview and suggestions:
        preview_paths = write_previews(reference_path, suggestions, report_path, args.preview_limit)

    applied: list[dict[str, Any]] = []
    if args.apply:
        applied = apply_suggestions(
            project_root,
            reference_path,
            reference_rgb.shape[1],
            reference_rgb.shape[0],
            mapping_path,
            mapping,
            suggestions,
            args.apply_threshold,
            args.overwrite,
            args.append_variant,
        )

    print(
        json.dumps(
            {
                "report": str(report_path),
                "preview": [str(path) for path in preview_paths],
                "suggestions": len(suggestions),
                "applied": len(applied),
                "top": [item.__dict__ for item in suggestions[:10]],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def slash_path(path: Path) -> str:
    return path.as_posix()


def load_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "templates": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def collect_template_contexts(maa_root: Path) -> list[TemplateContext]:
    contexts: list[TemplateContext] = []
    pipeline_root = maa_root / "assets/resource/base/pipeline"
    for path in sorted(pipeline_root.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        pipeline = slash_path(path.relative_to(maa_root))
        if isinstance(data, dict):
            for node, value in data.items():
                collect_templates_from_value(value, pipeline, node, None, contexts)
    return contexts


def collect_templates_from_value(
    value: Any,
    pipeline: str,
    node: str,
    inherited_roi: list[int] | None,
    contexts: list[TemplateContext],
) -> None:
    if isinstance(value, dict):
        roi = parse_roi(value.get("roi")) or inherited_roi
        template = value.get("template")
        if isinstance(template, str) and template:
            contexts.append(TemplateContext(template.replace("\\", "/"), pipeline, node, roi))
        elif isinstance(template, list):
            for item in template:
                if isinstance(item, str) and item:
                    contexts.append(TemplateContext(item.replace("\\", "/"), pipeline, node, roi))
        for child in value.values():
            collect_templates_from_value(child, pipeline, node, roi, contexts)
    elif isinstance(value, list):
        for child in value:
            collect_templates_from_value(child, pipeline, node, inherited_roi, contexts)


def parse_roi(value: Any) -> list[int] | None:
    if isinstance(value, list) and len(value) >= 4:
        try:
            return [int(value[0]), int(value[1]), int(value[2]), int(value[3])]
        except Exception:
            return None
    return None


def suggest_one(
    template_ref: str,
    source_path: Path,
    reference_gray: np.ndarray,
    reference_width: int,
    reference_height: int,
    already_mapped: bool,
    contexts: list[TemplateContext],
    coordinate_mode: str,
) -> Suggestion | None:
    try:
        template = Image.open(source_path).convert("L")
    except Exception:
        return None
    old_width, old_height = template.size
    if old_width < 8 or old_height < 8:
        return None
    if old_width * old_height > reference_width * reference_height * 0.2:
        return None

    template_np = np.array(template)
    best: tuple[float, list[int], float, list[int], TemplateContext, list[int] | None] | None = None
    search_windows = search_rois(contexts, reference_width, reference_height, coordinate_mode)
    for scale in DEFAULT_SCALES:
        width = max(4, int(round(old_width * scale)))
        height = max(4, int(round(old_height * scale)))
        if width >= reference_width or height >= reference_height:
            continue
        scaled = cv2.resize(template_np, (width, height), interpolation=cv2.INTER_AREA)
        if np.std(scaled) < 2:
            continue
        for context, search_roi in search_windows:
            x, y, roi_width, roi_height = search_roi or [0, 0, reference_width, reference_height]
            if roi_width < width or roi_height < height:
                continue
            search = reference_gray[y : y + roi_height, x : x + roi_width]
            result = cv2.matchTemplate(search, scaled, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)
            roi = [int(x + max_loc[0]), int(y + max_loc[1]), int(width), int(height)]
            if best is None or max_val > best[0]:
                best = (float(max_val), roi, scale, [width, height], context, search_roi)

    if best is None:
        return None
    score, roi, scale, new_size, context, search_roi = best
    if not math.isfinite(score):
        return None
    return Suggestion(
        template=template_ref,
        score=round(score, 5),
        roi=roi,
        scale=scale,
        old_size=[old_width, old_height],
        new_size=new_size,
        source_path=str(source_path),
        already_mapped=already_mapped,
        pipeline=context.pipeline or None,
        node=context.node or None,
        source_roi=context.roi,
        search_roi=search_roi,
    )


def search_rois(
    contexts: list[TemplateContext],
    image_width: int,
    image_height: int,
    coordinate_mode: str,
) -> list[tuple[TemplateContext, list[int] | None]]:
    windows: list[tuple[TemplateContext, list[int] | None]] = []
    seen: set[tuple[int, int, int, int] | None] = set()
    for context in contexts:
        mapped = map_roi(context.roi, image_width, image_height, coordinate_mode)
        clamped = clamp_roi(mapped, image_width, image_height) if mapped else None
        key = tuple(clamped) if clamped else None
        if key in seen:
            continue
        seen.add(key)
        windows.append((context, clamped))
    return windows or [(TemplateContext("", "", "", None), None)]


def map_roi(
    roi: list[int] | None,
    image_width: int,
    image_height: int,
    coordinate_mode: str,
) -> list[int] | None:
    if roi is None:
        return None
    if coordinate_mode == "stretch1280x720":
        scale_x = image_width / BASELINE_WIDTH
        scale_y = image_height / BASELINE_HEIGHT
        return [
            int(round(max(0, roi[0]) * scale_x)),
            int(round(max(0, roi[1]) * scale_y)),
            max(1, int(round(max(1, roi[2]) * scale_x))),
            max(1, int(round(max(1, roi[3]) * scale_y))),
        ]
    scale_x = image_width / VISIBLE_4X3_WIDTH
    scale_y = image_height / BASELINE_HEIGHT
    left = (roi[0] - VISIBLE_4X3_LEFT) * scale_x
    right = (roi[0] + max(1, roi[2]) - VISIBLE_4X3_LEFT) * scale_x
    return [
        int(round(left)),
        int(round(max(0, roi[1]) * scale_y)),
        max(1, int(round(max(1.0, right - left)))),
        max(1, int(round(max(1, roi[3]) * scale_y))),
    ]


def clamp_roi(roi: list[int], image_width: int, image_height: int) -> list[int]:
    x = max(0, min(image_width, int(roi[0])))
    y = max(0, min(image_height, int(roi[1])))
    right = max(x, min(image_width, int(roi[0] + max(1, roi[2]))))
    bottom = max(y, min(image_height, int(roi[1] + max(1, roi[3]))))
    return [x, y, max(1, right - x), max(1, bottom - y)]


def write_previews(
    reference_path: Path,
    suggestions: list[Suggestion],
    report_path: Path,
    limit: int,
) -> list[Path]:
    reference = Image.open(reference_path).convert("RGB")
    boxed = reference.copy()
    draw = ImageDraw.Draw(boxed)
    palette = [
        (255, 91, 91),
        (91, 166, 255),
        (255, 204, 92),
        (113, 219, 142),
        (205, 137, 255),
        (255, 145, 77),
    ]
    for index, item in enumerate(suggestions[: max(1, limit)], start=1):
        x, y, width, height = item.roi
        color = palette[(index - 1) % len(palette)]
        draw.rectangle((x, y, x + width, y + height), outline=color, width=2)
        draw.rectangle((x, max(0, y - 12), x + 64, y), fill=color)
        draw.text((x + 2, max(0, y - 12)), f"{index}:{item.score:.2f}", fill=(0, 0, 0))

    boxes_path = report_path.with_name(f"{report_path.stem}-boxes.png")
    boxed.save(boxes_path)

    row_height = 118
    left_width = 116
    crop_width = 116
    text_width = 580
    sheet_width = left_width + crop_width + text_width
    rows = suggestions[: max(1, limit)]
    sheet = Image.new("RGB", (sheet_width, row_height * len(rows)), (18, 20, 22))
    sheet_draw = ImageDraw.Draw(sheet)
    for row_index, item in enumerate(rows):
        y0 = row_index * row_height
        sheet_draw.rectangle((0, y0, sheet_width, y0 + row_height - 1), outline=(55, 62, 68))
        old = Image.open(item.source_path).convert("RGB")
        x, y, width, height = item.roi
        crop = reference.crop((x, y, x + width, y + height))
        sheet.paste(fit_image(old, 96, 96), (10, y0 + 11))
        sheet.paste(fit_image(crop, 96, 96), (left_width + 10, y0 + 11))
        color = palette[row_index % len(palette)]
        sheet_draw.rectangle((left_width + 8, y0 + 9, left_width + 108, y0 + 109), outline=color, width=2)
        text_x = left_width + crop_width + 14
        sheet_draw.text((text_x, y0 + 12), f"{row_index + 1}. {item.template}", fill=(242, 244, 245))
        sheet_draw.text(
            (text_x, y0 + 36),
            f"score={item.score:.5f}  roi={item.roi}  scale={item.scale}  old={item.old_size}",
            fill=(177, 188, 197),
        )
        sheet_draw.text((10, y0 + 98), "old", fill=(177, 188, 197))
        sheet_draw.text((left_width + 10, y0 + 98), "new", fill=(177, 188, 197))

    sheet_path = report_path.with_name(f"{report_path.stem}-sheet.png")
    sheet.save(sheet_path)
    return [boxes_path, sheet_path]


def fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    fitted = image.copy()
    fitted.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (max_width, max_height), (32, 36, 40))
    x = (max_width - fitted.width) // 2
    y = (max_height - fitted.height) // 2
    canvas.paste(fitted, (x, y))
    return canvas


def apply_suggestions(
    project_root: Path,
    reference_path: Path,
    reference_width: int,
    reference_height: int,
    mapping_path: Path,
    mapping: dict[str, Any],
    suggestions: list[Suggestion],
    threshold: float,
    overwrite: bool,
    append_variant: bool,
) -> list[dict[str, Any]]:
    templates = mapping.setdefault("templates", {})
    image = Image.open(reference_path).convert("RGB")
    applied: list[dict[str, Any]] = []
    for item in suggestions:
        if item.score < threshold:
            continue
        already_mapped = item.template in templates
        if already_mapped and not overwrite and not append_variant:
            continue
        x, y, width, height = item.roi
        crop = image.crop((x, y, x + width, y + height))
        save_path = template_save_path(project_root, item.template, already_mapped and append_variant)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        crop.save(save_path)
        entry = {
            "sourcePipeline": "suggest_templates.py/reference-image",
            "sourceNode": "offline template suggestion",
            "sourceRoi": item.roi,
            "sourceSpace": "imageSuggested",
            "coordinateMode": "image",
            "sourceImage": slash_path(reference_path.relative_to(project_root)),
            "sourceFrameWidth": reference_width,
            "sourceFrameHeight": reference_height,
            "replacementPath": slash_path(save_path.relative_to(project_root)),
            "width": width,
            "height": height,
            "matchScore": item.score,
            "matchScale": item.scale,
        }
        if item.pipeline:
            entry["matchedPipeline"] = item.pipeline
        if item.node:
            entry["matchedNode"] = item.node
        if already_mapped and append_variant:
            entry["name"] = f"suggested-{int(time.time())}"
            templates[item.template].setdefault("variants", []).append(entry)
        else:
            templates[item.template] = entry
        applied.append(item.__dict__)
    mapping_path.parent.mkdir(parents=True, exist_ok=True)
    mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
    return applied


def template_save_path(project_root: Path, template: str, variant: bool) -> Path:
    root = project_root / "assets/resource/ShiKong"
    template_path = Path(template)
    if not variant:
        return root / "image" / template_path
    return root / "image_variants" / template_path.with_name(
        f"{template_path.stem}-variant-{time.time_ns()}{template_path.suffix}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
