#!/usr/bin/env python3
"""Validate mapped ShiKong templates against their source images.

This is a read-only check. It reports whether every replacement image can be
found back in the source screenshot recorded by template_mapping.json.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image


DEFAULT_SOURCE_IMAGE = Path("assets/resource/ShiKong/captures/reference-image-1.png")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--min-score", type=float, default=0.82)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    items: list[dict[str, Any]] = []
    for template, meta in sorted(mapping.get("templates", {}).items()):
        for index, variant in enumerate(mapping_variants(meta)):
            replacement_path = variant.get("replacementPath")
            if not replacement_path:
                continue
            source_image = Path(variant.get("sourceImage") or DEFAULT_SOURCE_IMAGE)
            source_path = resolve(project_root, source_image)
            replacement = resolve(project_root, Path(replacement_path))
            result = validate_one(template, variant, source_path, replacement, args.min_score)
            result["variantIndex"] = index
            result["variantName"] = variant.get("name")
            items.append(result)

    passed = sum(1 for item in items if item["status"] == "pass")
    report = {
        "version": 1,
        "generatedAt": int(time.time()),
        "minScore": args.min_score,
        "total": len(items),
        "passed": passed,
        "failed": len(items) - passed,
        "items": items,
    }
    report_path = args.report or (
        project_root
        / "assets/resource/ShiKong/crop_plans"
        / f"template-validation-{time.time_ns()}.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "report": str(report_path),
                "total": report["total"],
                "passed": report["passed"],
                "failed": report["failed"],
                "failedItems": [
                    item["template"] for item in items if item["status"] != "pass"
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["failed"] == 0 else 2


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def mapping_variants(meta: dict[str, Any]) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    if any(key in meta for key in ("replacementPath", "sourceRoi", "sourceFrameWidth", "sourceFrameHeight")):
        variants.append(meta)
    for item in meta.get("variants") or []:
        if isinstance(item, dict):
            variants.append(item)
    return variants


def validate_one(
    template: str,
    meta: dict[str, Any],
    source_path: Path,
    replacement_path: Path,
    min_score: float,
) -> dict[str, Any]:
    if not source_path.is_file():
        return fail(template, f"source image missing: {source_path}", replacement_path)
    if not replacement_path.is_file():
        return fail(template, f"replacement missing: {replacement_path}", replacement_path)
    source = cv2.cvtColor(np.array(Image.open(source_path).convert("RGB")), cv2.COLOR_RGB2GRAY)
    replacement = cv2.cvtColor(
        np.array(Image.open(replacement_path).convert("RGB")), cv2.COLOR_RGB2GRAY
    )
    height, width = replacement.shape[:2]
    if width > source.shape[1] or height > source.shape[0]:
        return fail(template, "replacement is larger than source image", replacement_path)
    result = cv2.matchTemplate(source, replacement, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(result)
    roi = [int(loc[0]), int(loc[1]), int(width), int(height)]
    expected_roi = meta.get("sourceRoi")
    status = "pass" if score >= min_score else "low-score"
    distance = None
    if isinstance(expected_roi, list) and len(expected_roi) >= 2:
        distance = abs(int(expected_roi[0]) - roi[0]) + abs(int(expected_roi[1]) - roi[1])
        if distance > max(6, width // 3 + height // 3):
            status = "roi-drift"
    return {
        "template": template,
        "status": status,
        "score": round(float(score), 5),
        "bestRoi": roi,
        "expectedRoi": expected_roi,
        "roiDistance": distance,
        "replacementPath": str(replacement_path),
        "sourceImage": str(source_path),
    }


def fail(template: str, detail: str, replacement_path: Path) -> dict[str, Any]:
    return {
        "template": template,
        "status": "missing",
        "score": 0,
        "bestRoi": None,
        "expectedRoi": None,
        "roiDistance": None,
        "replacementPath": str(replacement_path),
        "detail": detail,
    }


if __name__ == "__main__":
    raise SystemExit(main())
