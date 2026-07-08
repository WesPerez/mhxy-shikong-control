#!/usr/bin/env python3
"""Apply an explicitly reviewed replacement crop.

This is for cases where automatic triage misses the semantically correct
candidate. It only writes files when --apply is passed.
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
    parser.add_argument("--template", required=True)
    parser.add_argument("--source-image", type=Path, required=True)
    parser.add_argument("--roi", required=True, help="x,y,width,height in source image coordinates")
    parser.add_argument("--source-node", default="manual-reviewed crop")
    parser.add_argument("--note", default=None)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    template = normalize_template(args.template)
    source_path = resolve(project_root, args.source_image)
    roi = parse_roi(args.roi)
    if not source_path.is_file():
        raise SystemExit(f"source image missing: {source_path}")

    image = Image.open(source_path).convert("RGB")
    if not valid_roi(roi, image.width, image.height):
        raise SystemExit(f"invalid roi {roi} for source {image.width}x{image.height}")

    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    templates = mapping.setdefault("templates", {})
    if template in templates and not args.overwrite:
        raise SystemExit(f"template already mapped: {template}; pass --overwrite to replace")

    x, y, width, height = roi
    crop = image.crop((x, y, x + width, y + height))
    save_path = project_root / "assets/resource/ShiKong/image" / Path(template)
    record: dict[str, Any] = {
        "sourcePipeline": "apply_manual_crop.py/manual-reviewed",
        "sourceNode": args.source_node,
        "sourceRoi": roi,
        "sourceSpace": "manualCrop",
        "coordinateMode": "image",
        "sourceImage": slash_path(source_path.relative_to(project_root)),
        "sourceFrameWidth": image.width,
        "sourceFrameHeight": image.height,
        "replacementPath": slash_path(save_path.relative_to(project_root)),
        "width": width,
        "height": height,
        "note": args.note or f"ShiKong manual-reviewed crop for Maa {template}.",
    }

    preview_path = None
    if args.preview:
        preview_path = write_preview(project_root, template, crop, record)

    if args.apply:
        save_path.parent.mkdir(parents=True, exist_ok=True)
        crop.save(save_path)
        templates[template] = record
        mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "dryRun": not args.apply,
                "template": template,
                "sourceImage": record["sourceImage"],
                "roi": roi,
                "replacementPath": record["replacementPath"],
                "preview": str(preview_path) if preview_path else None,
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


def normalize_template(value: str) -> str:
    return value.replace("\\", "/")


def parse_roi(value: str) -> list[int]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise SystemExit("--roi must be x,y,width,height")
    return [int(part) for part in parts]


def valid_roi(roi: list[int], width: int, height: int) -> bool:
    x, y, roi_width, roi_height = roi
    return x >= 0 and y >= 0 and roi_width > 0 and roi_height > 0 and x + roi_width <= width and y + roi_height <= height


def write_preview(project_root: Path, template: str, crop: Image.Image, record: dict[str, Any]) -> Path:
    width = 760
    height = 120
    preview = Image.new("RGB", (width, height), (18, 20, 22))
    draw = ImageDraw.Draw(preview)
    preview.paste(fit_image(crop, 180, 84), (12, 12))
    draw.text((12, 98), "new", fill=(177, 188, 197))
    draw.text((214, 18), template, fill=(242, 244, 245))
    draw.text((214, 44), f"roi={record['sourceRoi']}", fill=(177, 188, 197))
    draw.text((214, 70), record["replacementPath"], fill=(177, 188, 197))

    out_dir = project_root / "assets/resource/ShiKong/crop_plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"manual-crop-{Path(template).stem}-{time.time_ns()}.png"
    preview.save(path)
    return path


def fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    fitted = image.copy()
    fitted.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (max_width, max_height), (32, 36, 40))
    canvas.paste(fitted, ((max_width - fitted.width) // 2, (max_height - fitted.height) // 2))
    return canvas


if __name__ == "__main__":
    raise SystemExit(main())
