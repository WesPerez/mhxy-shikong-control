#!/usr/bin/env python3
"""Probe Maa template references against a ShiKong screenshot.

This is a read-only offline replay helper. It applies the same high-level
coordinate assumptions as the Rust runtime:
- base Maa templates/ROIs are mapped from the 1280x720 baseline into the
  visible 4:3 center crop by default.
- ShiKong replacement templates are scaled from their recorded source frame
  dimensions when template_mapping.json contains sourceFrameWidth/Height.
"""

from __future__ import annotations

import argparse
import json
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


@dataclass
class TemplateRef:
    pipeline: str
    node: str
    template: str
    roi: list[int] | None
    threshold: float


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument(
        "--coordinate-mode",
        choices=["cropCenter4x3", "stretch1280x720"],
        default="cropCenter4x3",
    )
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--preview-limit", type=int, default=80)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or project_root.parent / "Maa_MHXY_MG").resolve()
    image_path = resolve(project_root, args.image)
    screenshot = cv2.cvtColor(np.array(Image.open(image_path).convert("RGB")), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
    image_height, image_width = gray.shape[:2]

    mapping = load_mapping(project_root)
    refs = collect_template_refs(maa_root)
    items = []
    for ref in refs:
        item = probe_one(
            project_root,
            maa_root,
            mapping,
            ref,
            gray,
            image_width,
            image_height,
            args.coordinate_mode,
        )
        items.append(item)

    matched = [item for item in items if item["hit"]]
    mapped = [item for item in items if item["source"] == "ShiKong"]
    mapped_hit = [item for item in mapped if item["hit"]]
    report = {
        "version": 1,
        "generatedAt": int(time.time()),
        "image": relative_or_absolute(project_root, image_path),
        "imageSize": [image_width, image_height],
        "coordinateMode": args.coordinate_mode,
        "totalRefs": len(items),
        "matchedRefs": len(matched),
        "mappedRefs": len(mapped),
        "mappedMatchedRefs": len(mapped_hit),
        "uniqueMatchedTemplates": len({item["template"] for item in matched}),
        "items": items,
    }
    report_path = args.report or (
        project_root
        / "assets/resource/ShiKong/crop_plans"
        / f"template-probe-{time.time_ns()}.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    preview_paths: list[Path] = []
    if args.preview:
        preview_paths = write_preview(image_path, items, report_path, args.preview_limit)

    print(
        json.dumps(
            {
                "report": str(report_path),
                "preview": [str(path) for path in preview_paths],
                "totalRefs": report["totalRefs"],
                "matchedRefs": report["matchedRefs"],
                "mappedMatchedRefs": report["mappedMatchedRefs"],
                "uniqueMatchedTemplates": report["uniqueMatchedTemplates"],
                "top": sorted(items, key=lambda item: -item["score"])[:12],
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


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return slash_path(path.relative_to(root))
    except ValueError:
        return str(path)


def load_mapping(project_root: Path) -> dict[str, Any]:
    path = project_root / "assets/resource/ShiKong/template_mapping.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("templates", {})


def collect_template_refs(maa_root: Path) -> list[TemplateRef]:
    refs: list[TemplateRef] = []
    pipeline_root = maa_root / "assets/resource/base/pipeline"
    for path in sorted(pipeline_root.rglob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        pipeline = slash_path(path.relative_to(maa_root))
        for node, value in data.items():
            collect_templates_from_node(value, pipeline, node, None, 0.82, refs)
    return refs


def collect_templates_from_node(
    value: Any,
    pipeline: str,
    node: str,
    inherited_roi: list[int] | None,
    inherited_threshold: float,
    refs: list[TemplateRef],
) -> None:
    if isinstance(value, dict):
        roi = parse_roi(value.get("roi")) or inherited_roi
        thresholds = threshold_values(value.get("threshold"), inherited_threshold)
        templates = template_values(value.get("template"))
        for index, template in enumerate(templates):
            threshold = thresholds[min(index, len(thresholds) - 1)]
            refs.append(TemplateRef(pipeline, node, template, roi, threshold))
        for child in value.values():
            collect_templates_from_node(child, pipeline, node, roi, thresholds[-1], refs)
    elif isinstance(value, list):
        for child in value:
            collect_templates_from_node(
                child, pipeline, node, inherited_roi, inherited_threshold, refs
            )


def parse_roi(value: Any) -> list[int] | None:
    if isinstance(value, list) and len(value) >= 4:
        try:
            return [int(value[0]), int(value[1]), int(value[2]), int(value[3])]
        except Exception:
            return None
    return None


def threshold_values(value: Any, default: float) -> list[float]:
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, list):
        values = [float(item) for item in value if isinstance(item, (int, float))]
        return values or [default]
    return [default]


def template_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.replace("\\", "/")]
    if isinstance(value, list):
        return [item.replace("\\", "/") for item in value if isinstance(item, str)]
    return []


def probe_one(
    project_root: Path,
    maa_root: Path,
    mapping: dict[str, Any],
    ref: TemplateRef,
    gray: np.ndarray,
    image_width: int,
    image_height: int,
    coordinate_mode: str,
) -> dict[str, Any]:
    variants = resolve_template_variants(project_root, maa_root, mapping, ref.template)
    best: dict[str, Any] | None = None
    for template_path, source, meta in variants:
        base = {
            "pipeline": ref.pipeline,
            "node": ref.node,
            "template": ref.template,
            "roi": ref.roi,
            "threshold": ref.threshold,
            "source": source,
            "path": str(template_path) if template_path else None,
            "variantName": meta.get("name") if isinstance(meta, dict) else None,
        }
        if template_path is None or not template_path.is_file():
            candidate = with_result(base, hit=False, score=0.0, bestRoi=None, detail="missing template")
        else:
            candidate = match_one_variant(
                base,
                template_path,
                source,
                meta,
                ref,
                gray,
                image_width,
                image_height,
                coordinate_mode,
            )
        if best is None or candidate["score"] > best["score"]:
            best = candidate
    return best or {
        "pipeline": ref.pipeline,
        "node": ref.node,
        "template": ref.template,
        "roi": ref.roi,
        "threshold": ref.threshold,
        "source": "Maa",
        "path": None,
        "hit": False,
        "score": 0.0,
        "bestRoi": None,
        "detail": "missing template",
    }


def match_one_variant(
    base: dict[str, Any],
    template_path: Path,
    source: str,
    meta: dict[str, Any],
    ref: TemplateRef,
    gray: np.ndarray,
    image_width: int,
    image_height: int,
    coordinate_mode: str,
) -> dict[str, Any]:
    template = cv2.cvtColor(np.array(Image.open(template_path).convert("RGB")), cv2.COLOR_RGB2GRAY)
    template = scale_template(template, source, meta, image_width, image_height, coordinate_mode)
    roi = mapped_search_roi(meta, image_width, image_height) if source == "ShiKong" else None
    roi = roi or map_roi(ref.roi, image_width, image_height, coordinate_mode)
    if roi is None:
        roi = [0, 0, image_width, image_height]
    x, y, width, height = clamp_roi(roi, image_width, image_height)
    if width < template.shape[1] or height < template.shape[0]:
        return with_result(
            base, hit=False, score=0.0, bestRoi=None, detail="template larger than ROI"
        )
    search = gray[y : y + height, x : x + width]
    result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(result)
    best_roi = [int(x + loc[0]), int(y + loc[1]), int(template.shape[1]), int(template.shape[0])]
    return with_result(
        base,
        hit=float(score) >= ref.threshold,
        score=round(float(score), 5),
        bestRoi=best_roi,
        detail="matched" if float(score) >= ref.threshold else "below threshold",
    )


def with_result(base: dict[str, Any], **values: Any) -> dict[str, Any]:
    item = dict(base)
    item.update(values)
    return item


def resolve_template_variants(
    project_root: Path,
    maa_root: Path,
    mapping: dict[str, Any],
    template: str,
) -> list[tuple[Path | None, str, dict[str, Any]]]:
    meta = mapping.get(template) or {}
    variants = []
    for item in mapping_variants(meta):
        replacement = item.get("replacementPath")
        if replacement:
            path = resolve(project_root, Path(replacement))
            if path.is_file():
                variants.append((path, "ShiKong", item))
    variants.append((maa_root / "assets/resource/base/image" / template, "Maa", {}))
    return variants


def mapping_variants(meta: dict[str, Any]) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    if any(key in meta for key in ("replacementPath", "sourceRoi", "sourceFrameWidth", "sourceFrameHeight")):
        variants.append(meta)
    for item in meta.get("variants") or []:
        if isinstance(item, dict):
            variants.append(item)
    return variants


def scale_template(
    template: np.ndarray,
    source: str,
    meta: dict[str, Any],
    image_width: int,
    image_height: int,
    coordinate_mode: str,
) -> np.ndarray:
    if source == "ShiKong":
        source_width = int(meta.get("sourceFrameWidth") or image_width)
        source_height = int(meta.get("sourceFrameHeight") or image_height)
        scale_x = image_width / max(1, source_width)
        scale_y = image_height / max(1, source_height)
    elif coordinate_mode == "stretch1280x720":
        scale_x = image_width / BASELINE_WIDTH
        scale_y = image_height / BASELINE_HEIGHT
    else:
        scale_x = image_width / VISIBLE_4X3_WIDTH
        scale_y = image_height / BASELINE_HEIGHT
    width = max(1, int(round(template.shape[1] * scale_x)))
    height = max(1, int(round(template.shape[0] * scale_y)))
    if width == template.shape[1] and height == template.shape[0]:
        return template
    return cv2.resize(template, (width, height), interpolation=cv2.INTER_AREA)


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


def mapped_search_roi(meta: dict[str, Any], image_width: int, image_height: int) -> list[int] | None:
    roi = meta.get("sourceRoi")
    source_width = int(meta.get("sourceFrameWidth") or 0)
    source_height = int(meta.get("sourceFrameHeight") or 0)
    if not isinstance(roi, list) or len(roi) < 4 or source_width <= 0 or source_height <= 0:
        return None
    scale_x = image_width / source_width
    scale_y = image_height / source_height
    x = int(round(int(roi[0]) * scale_x))
    y = int(round(int(roi[1]) * scale_y))
    width = max(1, int(round(int(roi[2]) * scale_x)))
    height = max(1, int(round(int(roi[3]) * scale_y)))
    padding = max(6, int(round(max(width, height) * 0.35)))
    return [x - padding, y - padding, width + padding * 2, height + padding * 2]


def clamp_roi(roi: list[int], image_width: int, image_height: int) -> list[int]:
    left = max(0, roi[0])
    top = max(0, roi[1])
    right = min(image_width, roi[0] + max(1, roi[2]))
    bottom = min(image_height, roi[1] + max(1, roi[3]))
    return [left, top, max(1, right - left), max(1, bottom - top)]


def write_preview(
    image_path: Path,
    items: list[dict[str, Any]],
    report_path: Path,
    limit: int,
) -> list[Path]:
    image = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    hits = sorted([item for item in items if item["hit"]], key=lambda item: -item["score"])
    for index, item in enumerate(hits[: max(1, limit)], start=1):
        roi = item.get("bestRoi")
        if not roi:
            continue
        x, y, width, height = roi
        color = (87, 218, 137) if item["source"] == "ShiKong" else (255, 187, 80)
        draw.rectangle((x, y, x + width, y + height), outline=color, width=2)
        draw.text((x + 2, max(0, y - 12)), f"{index}:{item['score']:.2f}", fill=color)
    path = report_path.with_name(f"{report_path.stem}-hits.png")
    image.save(path)
    return [path]


if __name__ == "__main__":
    raise SystemExit(main())
