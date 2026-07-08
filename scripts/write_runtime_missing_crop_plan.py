#!/usr/bin/env python3
"""Write a crop plan containing only runtime-missing templates.

The generic crop-plan UI works from replacement coverage, which still leaves a
large queue after OCR/color fallbacks are counted. This script narrows the next
manual capture pass to the templates that are not runtime-covered in the latest
migration status report.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--status", type=Path, default=None)
    parser.add_argument("--image-path", default=None)
    parser.add_argument("--plan-name", default="runtime-missing-templates")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    status_path = resolve(
        project_root,
        args.status
        or Path("assets/resource/ShiKong/reports/latest-migration-status.json"),
    )
    status = json.loads(status_path.read_text(encoding="utf-8"))
    rows = [
        row
        for row in status.get("templates") or []
        if isinstance(row, dict) and not row.get("runtimeCovered")
    ]
    selected = rows[: args.limit] if args.limit and args.limit > 0 else rows
    image_path = args.image_path.strip() if args.image_path else None
    privilege_note = privilege_capture_note(status)
    items = [crop_plan_item(project_root, row, image_path, privilege_note) for row in selected]
    plan = {
        "version": 1,
        "name": args.plan_name,
        "defaultImagePath": image_path or None,
        "coordinateSpace": "image",
        "createdAt": int(time.time()),
        "captureRequirement": privilege_note,
        "summary": build_summary(items),
        "reviewRules": [
            "Only apply crops from real 梦幻西游：时空 screenshots, not low-score visual lookalikes.",
            "For inventory icons, crop the item icon from the bag/material grid; avoid menu buttons, panel borders, quantity text, and unrelated skill/activity icons.",
            "For wujian scene/NPC/floor templates, crop the actual in-scene target state; activity-list candidates are not valid replacements.",
            "After applying crops, run validate_mapped_templates.py and npm run status:migration before treating a template as covered.",
        ],
        "items": items,
    }

    out_dir = project_root / "assets/resource/ShiKong/crop_plans"
    out_dir.mkdir(parents=True, exist_ok=True)
    plan_path = out_dir / f"{sanitize(args.plan_name)}-{time.time_ns()}.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path = plan_path.with_suffix(".html")
    html_path.write_text(render_html_report(plan), encoding="utf-8")
    print(
        json.dumps(
            {
                "plan": str(plan_path),
                "html": str(html_path),
                "items": len(plan["items"]),
                "runtimeMissing": len(rows),
                "status": str(status_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def crop_plan_item(
    project_root: Path,
    row: dict[str, Any],
    image_path: str | None,
    privilege_note: str | None,
) -> dict[str, Any]:
    template = str(row.get("template") or "")
    guidance = template_guidance(template, row)
    old_image = (
        project_root.parent
        / "Maa_MHXY_MG"
        / "assets/resource/base/image"
        / Path(template)
    )
    return {
        "template": template,
        "imagePath": image_path,
        "roi": None,
        "oldImagePath": str(old_image),
        "category": guidance["category"],
        "captureScene": guidance["captureScene"],
        "cropTarget": guidance["cropTarget"],
        "acceptanceCriteria": guidance["acceptanceCriteria"],
        "rejectIf": guidance["rejectIf"],
        "recommendedCommand": guidance["recommendedCommand"],
        "note": "; ".join(
            [
                "runtimeMissing=true",
                f"category={guidance['category']}",
                f"domain={row.get('domain') or ''}",
                f"tasks={join_text(row.get('tasks'))}",
                f"nodes={join_text(row.get('nodes'))}",
                f"pipelines={join_text(row.get('pipelines'))}",
                f"rois={json.dumps(row.get('rois') or [], ensure_ascii=False)}",
                f"bestManifestScore={row.get('bestManifestScore')}",
                f"captureScene={guidance['captureScene']}",
                f"cropTarget={guidance['cropTarget']}",
                f"oldImage={old_image}",
                f"captureRequirement={privilege_note or 'none'}",
            ]
        ),
    }


def render_html_report(plan: dict[str, Any]) -> str:
    rows = "\n".join(render_html_row(item) for item in plan.get("items") or [])
    summary = html.escape(json.dumps(plan.get("summary") or {}, ensure_ascii=False))
    rules = "".join(f"<li>{html.escape(str(rule))}</li>" for rule in plan.get("reviewRules") or [])
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>{html.escape(str(plan.get("name") or "runtime missing"))}</title>
  <style>
    body {{ margin: 0; background: #11161b; color: #e8edf2; font: 14px/1.45 "Microsoft YaHei", Arial, sans-serif; }}
    main {{ padding: 20px; }}
    h1 {{ margin: 0 0 8px; font-size: 22px; }}
    .meta, code {{ color: #9fb0bf; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 16px; }}
    th, td {{ border-top: 1px solid #2c3842; padding: 10px; vertical-align: top; text-align: left; }}
    th {{ color: #bfd0dc; background: #172027; position: sticky; top: 0; }}
    img {{ image-rendering: auto; max-width: 96px; max-height: 72px; background: #242b31; border: 1px solid #38454f; }}
    .template {{ font-weight: 700; color: #fff; }}
    .category {{ color: #86d3ff; }}
    .reject {{ color: #ffb4a8; }}
  </style>
</head>
<body>
<main>
  <h1>{html.escape(str(plan.get("name") or "runtime missing"))}</h1>
  <div class="meta">createdAt={html.escape(str(plan.get("createdAt") or ""))} · summary={summary}</div>
  <div class="meta">captureRequirement={html.escape(str(plan.get("captureRequirement") or "none"))}</div>
  <ul>{rules}</ul>
  <table>
    <thead>
      <tr>
        <th>old</th>
        <th>template</th>
        <th>capture scene</th>
        <th>crop / acceptance</th>
        <th>reject if</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
</main>
</body>
</html>
"""


def render_html_row(item: dict[str, Any]) -> str:
    old_path = str(item.get("oldImagePath") or "")
    image = image_tag(old_path)
    template = html.escape(str(item.get("template") or ""))
    category = html.escape(str(item.get("category") or ""))
    capture_scene = html.escape(str(item.get("captureScene") or ""))
    crop_target = html.escape(str(item.get("cropTarget") or ""))
    acceptance = html.escape(str(item.get("acceptanceCriteria") or ""))
    reject_if = html.escape(str(item.get("rejectIf") or ""))
    command = html.escape(str(item.get("recommendedCommand") or ""))
    return f"""<tr>
  <td>{image}<br /><code>{html.escape(old_path)}</code></td>
  <td><div class="template">{template}</div><div class="category">{category}</div></td>
  <td>{capture_scene}<br /><code>{command}</code></td>
  <td>{crop_target}<br /><br />{acceptance}</td>
  <td class="reject">{reject_if}</td>
</tr>"""


def image_tag(path: str) -> str:
    image_path = Path(path)
    if not image_path.exists() or not image_path.is_file():
        return ""
    suffix = image_path.suffix.lower().lstrip(".") or "png"
    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f'<img alt="" src="data:image/{html.escape(suffix)};base64,{data}" />'


def build_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    categories = Counter(str(item.get("category") or "unknown") for item in items)
    return {
        "items": len(items),
        "categories": dict(sorted(categories.items())),
    }


def template_guidance(template: str, row: dict[str, Any]) -> dict[str, str]:
    if template.startswith("mijing_cailiao/"):
        material_name = Path(template).stem
        return {
            "category": "inventory-secret-realm-material",
            "captureScene": (
                "Open the backpack or material submission/storage view where this exact secret-realm "
                f"material is visible: {material_name}."
            ),
            "cropTarget": (
                "Crop the material item icon itself from the grid. Prefer the inner icon area and avoid "
                "variable quantity digits or selection glow unless they are unavoidable in the live UI."
            ),
            "acceptanceCriteria": (
                "The crop should be visually the same object as the old Maa material icon and should "
                "match inside the bag/material grid ROI used by 使用秘境材料."
            ),
            "rejectIf": (
                "Reject low-score matches from skill panels, furniture, activity rows, blank beige tiles, "
                "or any screenshot that does not show the named material in an inventory/material grid."
            ),
            "recommendedCommand": "npm run tauri:dev:admin, then use the UI drag-crop or a filled crop plan.",
        }
    if template == "beibao/guoqi.png":
        return {
            "category": "inventory-expired-item",
            "captureScene": "Open the backpack with an expired item visible in the item grid.",
            "cropTarget": "Crop the expired-item icon/overlay from the bag grid, not a panel control.",
            "acceptanceCriteria": "The crop must identify the expired item in the 整理背包 grid before the 使用 action.",
            "rejectIf": "Reject tiny red UI badges, close buttons, event markers, or any non-bag-grid red mark.",
            "recommendedCommand": "npm run tauri:dev:admin, open bag, then crop from live preview.",
        }
    if template in {
        "beibao/hongluogeng.png",
        "beibao/lvlugeng.png",
        "beibao/xinmobaozhu.png",
        "beibao/zhenfa.png",
    }:
        item_name = Path(template).stem
        return {
            "category": "inventory-item",
            "captureScene": f"Open the backpack with the exact item visible: {item_name}.",
            "cropTarget": "Crop the item icon in the bag grid. Keep the crop tight enough to avoid neighboring slots.",
            "acceptanceCriteria": "The crop should select the intended inventory item before the follow-up OCR menu action.",
            "rejectIf": "Reject activity icons, skill icons, panel decoration, partial borders, or blank slot fragments.",
            "recommendedCommand": "npm run tauri:dev:admin, open bag, then crop from live preview.",
        }
    if template.startswith("wujian/bcg/baicaogu_weizhi"):
        return {
            "category": "wujian-baicaogu-move-tile",
            "captureScene": "Enter the 百草谷/帮派 map state used after the activity starts.",
            "cropTarget": "Crop the real in-scene movement target tile/ground marker used by 百草谷-帮派-向下移动.",
            "acceptanceCriteria": "The crop should only appear at the intended map navigation position, not in the activity list.",
            "rejectIf": "Reject activity row images, buttons, beige panel backgrounds, or unrelated map/floor fragments.",
            "recommendedCommand": "npm run capture:scene:admin after entering the 百草谷/九黎 map scene, then crop with capture_scene_templates.py.",
        }
    if template == "wujian/bcg/baicaogu_shenshu_xiaoshi.png":
        return {
            "category": "wujian-baicaogu-state",
            "captureScene": "Capture the 百草谷 scene after the divine tree disappears/completion state is visible.",
            "cropTarget": "Crop the actual scene/state marker that proves 神树消失.",
            "acceptanceCriteria": "The crop must distinguish the post-tree state from normal 百草谷 scene and activity rows.",
            "rejectIf": "Reject generic 参加 buttons, activity list rows, or unrelated beige/gold UI panels.",
            "recommendedCommand": "npm run capture:scene:admin after progressing 百草谷 to the disappeared-tree state, then crop with capture_scene_templates.py.",
        }
    if template.startswith("wujian/mz/mizhen_chuansongren"):
        return {
            "category": "wujian-maze-teleporter-npc",
            "captureScene": "After starting 帮派迷阵, capture the in-scene teleporter NPC before clicking it.",
            "cropTarget": "Crop distinctive NPC body/clothing/head pixels from the actual map scene.",
            "acceptanceCriteria": "The crop should click the real 迷阵传送人 and should not match decorative sidebars or panels.",
            "rejectIf": "Reject activity-panel borders, beige blank areas, wood posts, or unrelated character fragments.",
            "recommendedCommand": "npm run capture:scene:admin after entering the 帮派迷阵 NPC scene, then crop with capture_scene_templates.py.",
        }
    if template.startswith("wujian/mz/mz_mubiao_diban"):
        return {
            "category": "wujian-maze-target-floor",
            "captureScene": "Inside 帮派迷阵, capture the target/end floor tile state.",
            "cropTarget": "Crop the actual target floor tile pattern, not an ordinary floor or activity UI.",
            "acceptanceCriteria": "The crop should only trigger when the maze endpoint floor is visible.",
            "rejectIf": "Reject ordinary wooden floors, activity panel backgrounds, or generic tile textures without the endpoint marker.",
            "recommendedCommand": "npm run capture:scene:admin at the 帮派迷阵 endpoint floor, then crop with capture_scene_templates.py.",
        }
    return {
        "category": "runtime-missing",
        "captureScene": f"Capture the real ShiKong state for nodes: {join_text(row.get('nodes'))}.",
        "cropTarget": "Crop the equivalent visual target used by the original Maa template.",
        "acceptanceCriteria": "The crop must hit the intended runtime target and avoid unrelated UI lookalikes.",
        "rejectIf": "Reject low-score visual-only candidates without matching task semantics.",
        "recommendedCommand": "npm run tauri:dev:admin, then use the UI drag-crop or a filled crop plan.",
    }


def privilege_capture_note(status: dict[str, Any]) -> str | None:
    window_status = status.get("windowStatus")
    if not isinstance(window_status, dict):
        return None
    current_elevated = window_status.get("currentProcessElevated")
    windows = window_status.get("windows")
    if current_elevated is False and isinstance(windows, list):
        elevated = [item for item in windows if isinstance(item, dict) and item.get("elevated") is True]
        if elevated:
            return (
                "current capture/control process is not elevated while at least one "
                "梦幻西游：时空 window is elevated; hwnd-targeted input requires running "
                "the helper/control app as administrator before interactive capture."
            )
    return None


def join_text(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    return " | ".join(str(item) for item in value if item)


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def sanitize(value: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "-_") else "_" for ch in value)
    return cleaned.strip("_") or "runtime-missing"


if __name__ == "__main__":
    raise SystemExit(main())
