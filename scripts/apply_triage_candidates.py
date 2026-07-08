#!/usr/bin/env python3
"""Apply manually approved template crops from a triage report.

The script is conservative by design: it only considers templates explicitly
listed with --template and only writes files when --apply is passed.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--template", action="append", required=True)
    parser.add_argument("--min-score", type=float, default=0.82)
    parser.add_argument("--note", default=None)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    report_path = resolve(project_root, args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    templates = mapping.setdefault("templates", {})
    wanted = {normalize_template(item) for item in args.template}

    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in report.get("rows", []):
        template = normalize_template(row.get("template"))
        if template not in wanted:
            continue
        candidates = row.get("candidates") or []
        if not candidates:
            skipped.append({"template": template, "reason": "no candidates"})
            continue
        candidate = best_candidate(candidates)
        score = float(candidate.get("score") or 0.0)
        if score < args.min_score:
            skipped.append({"template": template, "reason": "score below min", "score": score})
            continue
        if template in templates and not args.overwrite:
            existing = templates.get(template) or {}
            skipped.append(
                {
                    "template": template,
                    "reason": "already mapped",
                    "existingReplacementPath": existing.get("replacementPath"),
                    "existingSourceSpace": existing.get("sourceSpace"),
                }
            )
            continue
        selected.append({"row": row, "candidate": candidate})

    missing = sorted(wanted - {normalize_template(item["row"].get("template")) for item in selected})
    for template in missing:
        if not any(item.get("template") == template for item in skipped):
            skipped.append({"template": template, "reason": "template not found in report"})

    image_cache: dict[Path, Image.Image] = {}
    applied: list[dict[str, Any]] = []
    preview_items: list[dict[str, Any]] = []
    for item in selected:
        row = item["row"]
        candidate = item["candidate"]
        template = normalize_template(row["template"])
        image_value = candidate.get("image")
        if not image_value:
            skipped.append({"template": template, "reason": "candidate missing image"})
            continue
        image_path = resolve(project_root, Path(image_value))
        if not image_path.is_file():
            skipped.append({"template": template, "reason": "candidate image missing", "image": str(image_path)})
            continue
        image = image_cache.get(image_path)
        if image is None:
            image = Image.open(image_path).convert("RGB")
            image_cache[image_path] = image

        roi = normalize_roi(candidate.get("roi"))
        if not valid_roi(roi, image.width, image.height):
            skipped.append({"template": template, "reason": "invalid roi", "roi": candidate.get("roi")})
            continue

        x, y, width, height = roi
        crop = image.crop((x, y, x + width, y + height))
        save_path = project_root / "assets/resource/ShiKong/image" / Path(template)
        record = {
            "sourcePipeline": "template_triage_report.py/manual-approved",
            "sourceNode": first_string(row.get("nodes")) or "manual-approved triage candidate",
            "sourceRoi": roi,
            "sourceSpace": "triageCandidate",
            "coordinateMode": "image",
            "sourceImage": slash_path(image_path.relative_to(project_root)),
            "sourceFrameWidth": image.width,
            "sourceFrameHeight": image.height,
            "replacementPath": slash_path(save_path.relative_to(project_root)),
            "width": width,
            "height": height,
            "matchScore": round(float(candidate.get("score") or 0.0), 5),
            "matchScale": candidate.get("scale"),
            "triageReport": slash_path(report_path.relative_to(project_root)),
            "matchedPipelines": row.get("pipelines") or [],
            "matchedNodes": row.get("nodes") or [],
            "note": args.note or f"ShiKong manual-approved crop for Maa {template}.",
        }
        summary = {
            "template": template,
            "score": record["matchScore"],
            "roi": roi,
            "path": record["replacementPath"],
            "image": record["sourceImage"],
        }
        preview_items.append({"template": template, "crop": crop, "oldImagePath": row.get("oldImagePath"), **summary})
        if args.apply:
            save_path.parent.mkdir(parents=True, exist_ok=True)
            crop.save(save_path)
            templates[template] = record
            applied.append(summary)

    preview_path = None
    if args.preview and preview_items:
        preview_path = write_preview(project_root, report_path, preview_items)

    if args.apply and applied:
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "report": str(report_path),
                "dryRun": not args.apply,
                "selected": len(selected),
                "applied": len(applied),
                "skipped": len(skipped),
                "preview": str(preview_path) if preview_path else None,
                "appliedItems": applied,
                "selectedItems": [item for item in preview_items],
                "skippedItems": skipped,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )
    return 0


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def slash_path(path: Path) -> str:
    return path.as_posix()


def normalize_template(value: Any) -> str:
    return str(value or "").replace("\\", "/")


def normalize_roi(value: Any) -> list[int]:
    if not isinstance(value, list) or len(value) < 4:
        return []
    return [int(item) for item in value[:4]]


def best_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    return max(candidates, key=lambda item: float(item.get("score") or 0.0))


def valid_roi(roi: list[int], width: int, height: int) -> bool:
    if len(roi) != 4:
        return False
    x, y, roi_width, roi_height = roi
    return x >= 0 and y >= 0 and roi_width > 0 and roi_height > 0 and x + roi_width <= width and y + roi_height <= height


def first_string(values: Any) -> str | None:
    if not isinstance(values, list):
        return None
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def write_preview(project_root: Path, report_path: Path, items: list[dict[str, Any]]) -> Path:
    row_height = 134
    width = 980
    preview = Image.new("RGB", (width, row_height * len(items)), (18, 20, 22))
    draw = ImageDraw.Draw(preview)
    for index, item in enumerate(items):
        y = index * row_height
        draw.rectangle((0, y, width - 1, y + row_height - 1), outline=(55, 62, 68))
        old_path_value = item.get("oldImagePath")
        if old_path_value and Path(old_path_value).is_file():
            old_image = Image.open(old_path_value).convert("RGB")
            preview.paste(fit_image(old_image, 104, 84), (10, y + 12))
        preview.paste(fit_image(item["crop"], 160, 84), (132, y + 12))
        draw.text((10, y + 112), "old", fill=(177, 188, 197))
        draw.text((132, y + 112), "new", fill=(177, 188, 197))
        draw.text((314, y + 18), str(item["template"]), fill=(242, 244, 245))
        draw.text((314, y + 44), f"score={item['score']} roi={item['roi']}", fill=(177, 188, 197))
        draw.text((314, y + 70), str(item["path"]), fill=(177, 188, 197))
        draw.text((314, y + 96), str(item["image"]), fill=(128, 145, 156))

    out_dir = project_root / "assets/resource/ShiKong/crop_plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{report_path.stem}-apply-preview-{time.time_ns()}.png"
    preview.save(path)
    return path


def fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    fitted = image.copy()
    fitted.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (max_width, max_height), (32, 36, 40))
    x = (max_width - fitted.width) // 2
    y = (max_height - fitted.height) // 2
    canvas.paste(fitted, (x, y))
    return canvas


if __name__ == "__main__":
    raise SystemExit(main())
