#!/usr/bin/env python3
"""Append ShiKong template variants from an aggregate manifest probe report.

This consumes reports produced by probe_capture_manifest.py. It crops the
best high-confidence ShiKong matches from the capture screenshots and appends
them to template_mapping.json as variants. The script is dry-run by default;
pass --apply to write crops and update the mapping file.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--min-score", type=float, default=0.94)
    parser.add_argument("--max-per-template", type=int, default=1)
    parser.add_argument(
        "--name",
        default=None,
        help="Use one explicit variant name for every selected template.",
    )
    parser.add_argument("--apply", action="store_true", help="Write variant crops and update template_mapping.json.")
    parser.add_argument("--dry-run", action="store_true", help="Force read-only mode. This is also the default.")
    args = parser.parse_args()

    if args.apply and args.dry_run:
        parser.error("--apply and --dry-run cannot be used together")

    dry_run = not args.apply
    project_root = args.project_root.resolve()
    report_path = resolve(project_root, args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    templates = mapping.setdefault("templates", {})

    selected = select_candidates(
        report.get("variantCandidates", []),
        args.min_score,
        args.max_per_template,
    )
    image_cache: dict[Path, Image.Image] = {}
    would_apply: list[dict[str, Any]] = []
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for item in selected:
        template = item["template"]
        if template not in templates:
            skipped.append({"template": template, "reason": "template not in mapping"})
            continue

        capture_image_value = item.get("captureImage")
        if not capture_image_value:
            skipped.append({"template": template, "reason": "missing captureImage"})
            continue
        image_path = resolve(project_root, Path(capture_image_value))
        if not image_path.is_file():
            skipped.append(
                {
                    "template": template,
                    "reason": "captureImage not found",
                    "captureImage": str(image_path),
                }
            )
            continue

        image = image_cache.get(image_path)
        if image is None:
            image = Image.open(image_path).convert("RGB")
            image_cache[image_path] = image
        image_width, image_height = image.size

        roi = normalize_roi(item.get("bestRoi"))
        if not valid_roi(roi, image_width, image_height):
            skipped.append({"template": template, "reason": "invalid bestRoi", "bestRoi": item.get("bestRoi")})
            continue

        variant_name = variant_name_for(item, image_width, image_height, args.name)
        save_path = variant_save_path(project_root, template, variant_name)
        entry = templates[template]
        duplicate = variant_duplicate_reason(entry, project_root, image_path, roi, variant_name, save_path)
        if duplicate:
            skipped.append(
                {
                    "template": template,
                    "reason": duplicate,
                    "name": variant_name,
                    "bestRoi": roi,
                    "path": slash_path(save_path.relative_to(project_root)),
                }
            )
            continue

        x, y, width, height = roi
        crop = image.crop((x, y, x + width, y + height))
        record = {
            "name": variant_name,
            "sourcePipeline": item.get("pipeline"),
            "sourceNode": item.get("node"),
            "sourceRoi": roi,
            "sourceSpace": "manifestProbeVariant",
            "coordinateMode": "image",
            "sourceImage": slash_path(image_path.relative_to(project_root)),
            "sourceFrameWidth": image_width,
            "sourceFrameHeight": image_height,
            "replacementPath": slash_path(save_path.relative_to(project_root)),
            "width": width,
            "height": height,
            "matchScore": item.get("score"),
            "threshold": item.get("threshold"),
            "manifestReport": slash_path(report_path.relative_to(project_root)),
            "manifest": report.get("manifest"),
            "probeReport": item.get("captureReport"),
            "captureName": item.get("captureName"),
        }
        summary = {
            "template": template,
            "name": variant_name,
            "score": item.get("score"),
            "bestRoi": roi,
            "path": record["replacementPath"],
            "captureImage": record["sourceImage"],
        }
        would_apply.append(summary)
        if not dry_run:
            save_path.parent.mkdir(parents=True, exist_ok=True)
            crop.save(save_path)
            entry.setdefault("variants", []).append(record)
            applied.append(summary)

    if not dry_run and applied:
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    output = {
        "report": str(report_path),
        "dryRun": dry_run,
        "selected": len(selected),
        "wouldApply": len(would_apply),
        "applied": len(applied),
        "skipped": len(skipped),
        "wouldApplyItems": would_apply,
        "appliedItems": applied,
        "skippedItems": skipped[:50],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def select_candidates(items: list[dict[str, Any]], min_score: float, max_per_template: int) -> list[dict[str, Any]]:
    hits = [
        item
        for item in items
        if item.get("hit")
        and item.get("source") == "ShiKong"
        and item.get("template")
        and item.get("bestRoi")
        and float(item.get("score") or 0.0) >= min_score
    ]
    hits.sort(key=lambda item: (-float(item.get("score") or 0.0), item.get("template") or ""))
    selected: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for item in hits:
        template = item["template"]
        if counts.get(template, 0) >= max_per_template:
            continue
        counts[template] = counts.get(template, 0) + 1
        selected.append(item)
    return selected


def normalize_roi(roi: Any) -> list[int]:
    if not isinstance(roi, list) or len(roi) < 4:
        return []
    return [int(value) for value in roi[:4]]


def valid_roi(roi: list[int], width: int, height: int) -> bool:
    if len(roi) != 4:
        return False
    x, y, roi_width, roi_height = roi
    return x >= 0 and y >= 0 and roi_width > 0 and roi_height > 0 and x + roi_width <= width and y + roi_height <= height


def variant_duplicate_reason(
    entry: dict[str, Any],
    project_root: Path,
    image_path: Path,
    roi: list[int],
    variant_name: str,
    save_path: Path,
) -> str | None:
    for candidate in variant_records(entry):
        if candidate.get("name") == variant_name:
            return "variant name already exists"
        candidate_roi = candidate.get("sourceRoi")
        source_image = str(candidate.get("sourceImage") or "")
        if candidate_roi == roi and same_source_image(project_root, source_image, image_path):
            return "variant source image and ROI already exist"
        replacement = candidate.get("replacementPath")
        if replacement and resolve(project_root, Path(str(replacement))).resolve() == save_path.resolve():
            return "variant replacement path already exists"
    if save_path.exists():
        return "variant file already exists"
    return None


def variant_records(entry: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if isinstance(entry, dict):
        records.append(entry)
        records.extend(item for item in entry.get("variants") or [] if isinstance(item, dict))
    return records


def same_source_image(project_root: Path, source_image: str, image_path: Path) -> bool:
    if not source_image:
        return False
    source_path = resolve(project_root, Path(source_image))
    if source_path.resolve() == image_path.resolve():
        return True
    return source_image.replace("\\", "/").endswith(image_path.name)


def variant_name_for(item: dict[str, Any], image_width: int, image_height: int, explicit_name: str | None) -> str:
    if explicit_name:
        return sanitize(explicit_name)
    capture_name = str(item.get("captureName") or "capture")
    return sanitize(f"{capture_name}-{image_width}x{image_height}")


def variant_save_path(project_root: Path, template: str, variant_name: str) -> Path:
    template_path = Path(template)
    return project_root / "assets/resource/ShiKong/image_variants" / template_path.with_name(
        f"{template_path.stem}-{variant_name}{template_path.suffix}"
    )


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def slash_path(path: Path) -> str:
    return path.as_posix()


def sanitize(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "-" for ch in value)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "variant"


if __name__ == "__main__":
    raise SystemExit(main())
