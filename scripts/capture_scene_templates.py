#!/usr/bin/env python3
"""Capture reviewed scene templates from the live ShiKong client window.

This helper is for runtime-missing scene targets that cannot be safely replaced
from old low-score screenshots. It captures the current client frame and can
apply explicitly reviewed crop rectangles to template_mapping.json.

The script does not move the real mouse and does not post input messages.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

import capture_window


DEFAULT_TITLE = "梦幻西游：时空"
DEFAULT_STATUS = Path("assets/resource/ShiKong/reports/latest-migration-status.json")


@dataclass(frozen=True)
class CropSpec:
    template: str
    roi: tuple[int, int, int, int]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--target", action="append", default=[], help="Template path to include. May be repeated.")
    parser.add_argument(
        "--roi",
        action="append",
        default=[],
        help="Reviewed crop as template=x,y,width,height. May be repeated.",
    )
    parser.add_argument("--report-name", default=None)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--preview", action="store_true", help="Write preview sheets for provided ROIs.")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    status_path = resolve(project_root, args.status)
    status = read_json(status_path)
    missing = runtime_missing_templates(status)
    targets = select_targets(args.target, missing)
    crop_specs = parse_crop_specs(args.roi)
    unknown = sorted({spec.template for spec in crop_specs if spec.template not in targets})
    if unknown:
        raise SystemExit(f"ROI template is not selected/runtime-missing: {', '.join(unknown)}")

    capture_window.set_dpi_awareness()
    current_elevated = capture_window.current_process_elevated()
    windows = capture_window.list_windows(args.title)
    if not windows:
        raise SystemExit(f"no window title contains: {args.title}")
    if args.index < 0 or args.index >= len(windows):
        raise SystemExit(f"window index {args.index} out of range, found {len(windows)}")

    window = windows[args.index]
    hwnd = capture_window.wintypes.HWND(window["hwnd"])
    image, meta = capture_window.capture_client(hwnd)
    run_dir = output_dir(project_root, args.report_name)
    run_dir.mkdir(parents=True, exist_ok=True)
    frame_path = run_dir / "scene-frame.png"
    image.save(frame_path)

    mapping_updates: list[dict[str, Any]] = []
    previews: list[str] = []
    if crop_specs:
        mapping_path = project_root / "assets/resource/ShiKong/template_mapping.json"
        mapping = read_json(mapping_path)
        templates = mapping.setdefault("templates", {})
        if not isinstance(templates, dict):
            raise RuntimeError(f"{mapping_path} templates must be an object")

        for spec in crop_specs:
            if spec.template in templates and not args.overwrite:
                mapping_updates.append(
                    {
                        "template": spec.template,
                        "status": "skipped-existing-mapping",
                        "roi": list(spec.roi),
                    }
                )
                continue
            if not valid_roi(spec.roi, image.width, image.height):
                raise SystemExit(f"invalid roi for {spec.template}: {spec.roi} on {image.width}x{image.height}")
            crop = crop_image(image, spec.roi)
            save_path = project_root / "assets/resource/ShiKong/image" / Path(spec.template)
            record = mapping_record(project_root, spec, frame_path, save_path, image, crop)
            if args.preview or args.apply:
                preview_path = write_preview(project_root, spec.template, crop, record)
                previews.append(str(preview_path))
            if args.apply:
                save_path.parent.mkdir(parents=True, exist_ok=True)
                crop.save(save_path)
                templates[spec.template] = record
                status_text = "applied"
            else:
                status_text = "previewed" if args.preview else "dry-run"
            mapping_updates.append(
                {
                    "template": spec.template,
                    "status": status_text,
                    "roi": list(spec.roi),
                    "replacementPath": slash_path(save_path.relative_to(project_root)),
                    "width": crop.width,
                    "height": crop.height,
                }
            )
        if args.apply:
            mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "version": 1,
        "status": "ok",
        "applied": bool(args.apply),
        "projectRoot": str(project_root),
        "statusReport": str(status_path),
        "window": window,
        "currentProcessElevated": current_elevated,
        "captureMeta": {**meta, "path": str(frame_path)},
        "targets": [template_row(project_root, status, template) for template in targets],
        "cropSpecs": [{"template": spec.template, "roi": list(spec.roi)} for spec in crop_specs],
        "mappingUpdates": mapping_updates,
        "previews": previews,
        "nextCommands": next_commands(targets, frame_path),
    }
    report_path = run_dir / "scene-template-capture-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path = run_dir / "scene-template-capture-report.html"
    html_path.write_text(render_html_report(report), encoding="utf-8")

    print(
        json.dumps(
            {
                "report": str(report_path),
                "html": str(html_path),
                "frame": str(frame_path),
                "targets": len(targets),
                "cropSpecs": len(crop_specs),
                "applied": bool(args.apply),
                "updates": mapping_updates,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def runtime_missing_templates(status: dict[str, Any]) -> list[str]:
    rows = status.get("templates") or []
    return [
        str(row.get("template") or "")
        for row in rows
        if isinstance(row, dict) and row.get("template") and not row.get("runtimeCovered")
    ]


def select_targets(values: list[str], missing: list[str]) -> list[str]:
    selected: list[str] = []
    for value in values:
        for item in value.split(","):
            template = normalize_template(item.strip())
            if template:
                selected.append(template)
    if not selected:
        selected = list(missing)
    missing_set = set(missing)
    unknown = sorted(template for template in selected if template not in missing_set)
    if unknown:
        raise SystemExit(f"selected template is not runtime-missing: {', '.join(unknown)}")
    return list(dict.fromkeys(selected))


def parse_crop_specs(values: list[str]) -> list[CropSpec]:
    specs: list[CropSpec] = []
    for value in values:
        template, separator, roi_text = value.partition("=")
        if not separator:
            raise SystemExit("--roi must be template=x,y,width,height")
        specs.append(CropSpec(normalize_template(template.strip()), parse_roi(roi_text)))
    return specs


def parse_roi(value: str) -> tuple[int, int, int, int]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise SystemExit("--roi must be x,y,width,height")
    x, y, width, height = (int(part) for part in parts)
    return (x, y, width, height)


def mapping_record(
    project_root: Path,
    spec: CropSpec,
    frame_path: Path,
    save_path: Path,
    image: Image.Image,
    crop: Image.Image,
) -> dict[str, Any]:
    return {
        "sourcePipeline": "scripts/capture_scene_templates.py/manual-reviewed",
        "sourceNode": "live scene reviewed crop",
        "sourceRoi": list(spec.roi),
        "sourceSpace": "sceneCapture",
        "coordinateMode": "client",
        "sourceImage": relative_or_absolute(project_root, frame_path),
        "sourceFrameWidth": image.width,
        "sourceFrameHeight": image.height,
        "replacementPath": slash_path(save_path.relative_to(project_root)),
        "width": crop.width,
        "height": crop.height,
        "note": (
            "Captured from a real 梦幻西游：时空 client scene after manual review. "
            "Use validate_mapped_templates.py and migration_status.py before treating as complete."
        ),
    }


def render_html_report(report: dict[str, Any]) -> str:
    frame_path = str((report.get("captureMeta") or {}).get("path") or "")
    rows = "\n".join(render_target_row(item, frame_path) for item in report.get("targets") or [])
    updates = "\n".join(render_update_row(item) for item in report.get("mappingUpdates") or [])
    commands = "\n".join(f"<li><code>{html.escape(command)}</code></li>" for command in report.get("nextCommands") or [])
    frame = image_tag(frame_path, max_width=640)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>scene template capture</title>
  <style>
    body {{ margin: 0; background: #101417; color: #e8edf2; font: 14px/1.45 "Microsoft YaHei", Arial, sans-serif; }}
    main {{ padding: 20px; }}
    h1 {{ margin: 0 0 8px; font-size: 22px; }}
    h2 {{ margin-top: 22px; font-size: 17px; }}
    code, .meta {{ color: #9fb0bf; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 12px; }}
    th, td {{ border-top: 1px solid #2b3740; padding: 10px; vertical-align: top; text-align: left; }}
    th {{ color: #bfd0dc; background: #172027; }}
    img {{ background: #20282f; border: 1px solid #33414b; }}
    .old img {{ max-width: 128px; max-height: 96px; }}
    .template {{ font-weight: 700; color: #fff; }}
    .warn {{ color: #ffbd8a; }}
  </style>
</head>
<body>
<main>
  <h1>scene template capture</h1>
  <div class="meta">frame={html.escape(frame_path)}</div>
  <div>{frame}</div>
  <h2>runtime-missing targets</h2>
  <table><thead><tr><th>old</th><th>template</th><th>nodes</th><th>recommended crop</th></tr></thead><tbody>{rows}</tbody></table>
  <h2>applied / previewed crops</h2>
  <table><thead><tr><th>template</th><th>status</th><th>roi</th><th>replacement</th></tr></thead><tbody>{updates}</tbody></table>
  <h2>next commands</h2>
  <ul>{commands}</ul>
  <p class="warn">Only apply crops from the correct live scene. Low-score lookalikes from activity panels or ordinary floors are not valid.</p>
</main>
</body>
</html>
"""


def render_target_row(item: dict[str, Any], frame_path: str) -> str:
    template = html.escape(str(item.get("template") or ""))
    old_path = str(item.get("oldImagePath") or "")
    nodes = html.escape(" | ".join(str(node) for node in item.get("nodes") or []))
    guidance = html.escape(crop_guidance(str(item.get("template") or "")))
    command = html.escape(f"python scripts/capture_scene_templates.py --roi \"{template}=x,y,w,h\" --preview")
    return f"""<tr>
  <td class="old">{image_tag(old_path, max_width=128)}<br /><code>{html.escape(old_path)}</code></td>
  <td><div class="template">{template}</div></td>
  <td>{nodes}</td>
  <td>{guidance}<br /><code>{command}</code><br /><code>source frame: {html.escape(frame_path)}</code></td>
</tr>"""


def render_update_row(item: dict[str, Any]) -> str:
    return f"""<tr>
  <td><code>{html.escape(str(item.get("template") or ""))}</code></td>
  <td>{html.escape(str(item.get("status") or ""))}</td>
  <td><code>{html.escape(json.dumps(item.get("roi") or [], ensure_ascii=False))}</code></td>
  <td><code>{html.escape(str(item.get("replacementPath") or ""))}</code></td>
</tr>"""


def next_commands(targets: list[str], frame_path: Path) -> list[str]:
    commands = [
        f"python scripts/capture_scene_templates.py --roi \"{targets[0]}=x,y,w,h\" --preview"
        if targets
        else "python scripts/capture_scene_templates.py",
        "python scripts/validate_mapped_templates.py",
        "python scripts/migration_status.py",
    ]
    if targets:
        commands.insert(
            1,
            f"python scripts/apply_manual_crop.py --template {targets[0]} --source-image {frame_path} --roi x,y,w,h --preview",
        )
    return commands


def template_row(project_root: Path, status: dict[str, Any], template: str) -> dict[str, Any]:
    rows = status.get("templates") or []
    row = next((item for item in rows if isinstance(item, dict) and item.get("template") == template), {})
    old_image = project_root.parent / "Maa_MHXY_MG/assets/resource/base/image" / Path(template)
    return {
        "template": template,
        "nodes": row.get("nodes") or [],
        "pipelines": row.get("pipelines") or [],
        "tasks": row.get("tasks") or [],
        "oldImagePath": str(old_image),
    }


def crop_guidance(template: str) -> str:
    if template.startswith("wujian/bcg/baicaogu_weizhi"):
        return "Crop the actual in-scene 百草谷/九黎 movement ground marker after 帮派地图 is visible."
    if template == "wujian/bcg/baicaogu_shenshu_xiaoshi.png":
        return "Crop the real completed/disappeared tree state marker in 百草谷."
    if template.startswith("wujian/mz/mz_mubiao_diban"):
        return "Crop the actual target/end floor tile inside 帮派迷阵, not an ordinary floor texture."
    return "Crop the equivalent live scene target."


def valid_roi(roi: tuple[int, int, int, int], width: int, height: int) -> bool:
    x, y, roi_width, roi_height = roi
    return x >= 0 and y >= 0 and roi_width > 0 and roi_height > 0 and x + roi_width <= width and y + roi_height <= height


def crop_image(image: Image.Image, roi: tuple[int, int, int, int]) -> Image.Image:
    x, y, width, height = roi
    return image.crop((x, y, x + width, y + height))


def write_preview(project_root: Path, template: str, crop: Image.Image, record: dict[str, Any]) -> Path:
    width = 820
    height = 132
    preview = Image.new("RGB", (width, height), (18, 20, 22))
    draw = ImageDraw.Draw(preview)
    preview.paste(fit_image(crop, 190, 96), (12, 12))
    draw.text((12, 110), "new scene crop", fill=(177, 188, 197))
    draw.text((224, 18), template, fill=(242, 244, 245))
    draw.text((224, 44), f"roi={record['sourceRoi']}", fill=(177, 188, 197))
    draw.text((224, 70), record["replacementPath"], fill=(177, 188, 197))
    draw.text((224, 96), record["sourceImage"], fill=(177, 188, 197))
    out_dir = project_root / "assets/resource/ShiKong/crop_plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"scene-crop-{safe_stem(template)}-{time.time_ns()}.png"
    preview.save(path)
    return path


def fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    fitted = image.copy()
    fitted.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (max_width, max_height), (32, 36, 40))
    canvas.paste(fitted, ((max_width - fitted.width) // 2, (max_height - fitted.height) // 2))
    return canvas


def image_tag(path: str, max_width: int) -> str:
    image_path = Path(path)
    if not image_path.is_file():
        return ""
    suffix = image_path.suffix.lower().lstrip(".") or "png"
    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return (
        f'<img alt="" style="max-width:{max_width}px;max-height:{max_width}px" '
        f'src="data:image/{html.escape(suffix)};base64,{data}" />'
    )


def output_dir(project_root: Path, report_name: str | None) -> Path:
    name = report_name or f"scene-template-capture-{time.time_ns()}"
    return project_root / "assets/resource/ShiKong/crop_plans" / safe_stem(name)


def safe_stem(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value.replace("/", "_"))
    return cleaned.strip("_") or "scene-template-capture"


def normalize_template(value: str) -> str:
    return value.replace("\\", "/")


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise SystemExit(f"missing JSON file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def slash_path(path: Path) -> str:
    return path.as_posix()


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return slash_path(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    raise SystemExit(main())
