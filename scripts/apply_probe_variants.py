#!/usr/bin/env python3
"""Append ShiKong template variants from a successful probe report.

This consumes reports produced by probe_pipeline_templates.py. It only uses
items that already matched an existing ShiKong template, then crops the matched
location from the probed screenshot and appends it to template_mapping.json as a
variant. This is useful for preserving confirmed matches from another client
size or DPI scale without overwriting the original template.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--min-score", type=float, default=0.94)
    parser.add_argument("--max-per-template", type=int, default=1)
    parser.add_argument("--name", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    report_path = resolve(project_root, args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    image_path = resolve(project_root, Path(report["image"]))
    image = Image.open(image_path).convert("RGB")
    image_width, image_height = image.size
    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    templates = mapping.setdefault("templates", {})

    selected = select_items(report.get("items", []), args.min_score, args.max_per_template)
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for item in selected:
        template = item["template"]
        roi = item.get("bestRoi")
        if not valid_roi(roi, image_width, image_height):
            skipped.append({"template": template, "reason": "invalid bestRoi", "bestRoi": roi})
            continue
        if template not in templates:
            skipped.append({"template": template, "reason": "template not in mapping"})
            continue
        if variant_exists(templates[template], image_path, roi):
            skipped.append({"template": template, "reason": "variant already exists", "bestRoi": roi})
            continue

        x, y, width, height = [int(value) for value in roi]
        crop = image.crop((x, y, x + width, y + height))
        save_path = variant_save_path(project_root, template, args.name)
        if not args.dry_run:
            save_path.parent.mkdir(parents=True, exist_ok=True)
            crop.save(save_path)
            templates[template].setdefault("variants", []).append(
                {
                    "name": args.name or f"probe-{int(time.time())}",
                    "sourcePipeline": item.get("pipeline"),
                    "sourceNode": item.get("node"),
                    "sourceRoi": [x, y, width, height],
                    "sourceSpace": "probeVariant",
                    "coordinateMode": "image",
                    "sourceImage": slash_path(image_path.relative_to(project_root)),
                    "sourceFrameWidth": image_width,
                    "sourceFrameHeight": image_height,
                    "replacementPath": slash_path(save_path.relative_to(project_root)),
                    "width": width,
                    "height": height,
                    "matchScore": item.get("score"),
                    "probeReport": slash_path(report_path.relative_to(project_root)),
                }
            )
        applied.append(
            {
                "template": template,
                "score": item.get("score"),
                "bestRoi": roi,
                "path": slash_path(save_path.relative_to(project_root)),
            }
        )

    if not args.dry_run:
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    output = {
        "report": str(report_path),
        "image": str(image_path),
        "dryRun": args.dry_run,
        "selected": len(selected),
        "applied": len(applied),
        "skipped": len(skipped),
        "appliedItems": applied,
        "skippedItems": skipped[:20],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def slash_path(path: Path) -> str:
    return path.as_posix()


def select_items(items: list[dict[str, Any]], min_score: float, max_per_template: int) -> list[dict[str, Any]]:
    hits = [
        item
        for item in items
        if item.get("hit")
        and item.get("source") == "ShiKong"
        and float(item.get("score") or 0) >= min_score
        and item.get("bestRoi")
    ]
    hits.sort(key=lambda item: (-float(item.get("score") or 0), item.get("template") or ""))
    selected: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for item in hits:
        template = item["template"]
        if counts.get(template, 0) >= max_per_template:
            continue
        counts[template] = counts.get(template, 0) + 1
        selected.append(item)
    return selected


def valid_roi(roi: Any, width: int, height: int) -> bool:
    if not isinstance(roi, list) or len(roi) < 4:
        return False
    x, y, roi_width, roi_height = [int(value) for value in roi[:4]]
    return x >= 0 and y >= 0 and roi_width > 0 and roi_height > 0 and x + roi_width <= width and y + roi_height <= height


def variant_exists(entry: dict[str, Any], image_path: Path, roi: list[int]) -> bool:
    source_image = slash_path(image_path)
    candidates = []
    if isinstance(entry, dict):
        candidates.append(entry)
        candidates.extend(item for item in entry.get("variants") or [] if isinstance(item, dict))
    for candidate in candidates:
        candidate_roi = candidate.get("sourceRoi")
        if candidate_roi == roi and str(candidate.get("sourceImage") or "").endswith(image_path.name):
            return True
        if candidate_roi == roi and str(candidate.get("sourceImage") or "") == source_image:
            return True
    return False


def variant_save_path(project_root: Path, template: str, name: str | None) -> Path:
    template_path = Path(template)
    suffix = sanitize(name or f"probe-{time.time_ns()}")
    return project_root / "assets/resource/ShiKong/image_variants" / template_path.with_name(
        f"{template_path.stem}-{suffix}{template_path.suffix}"
    )


def sanitize(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "-" for ch in value)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "variant"


if __name__ == "__main__":
    raise SystemExit(main())
