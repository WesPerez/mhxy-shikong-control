from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "src" / "asset-store-core.js"
MAIN = ROOT / "src" / "main.js"

REQUIRED_EXPORTS = [
    "parseDataUrl",
    "buildAssetRelativePath",
    "fileizeWorkspaceAssets",
    "prepareWorkspaceForPersistence",
    "rehydrateTargetAssets",
]


def main() -> int:
    text = CORE.read_text(encoding="utf-8")
    missing = [name for name in REQUIRED_EXPORTS if f"export function {name}" not in text and f"export async function {name}" not in text]
    if missing:
        print("missing exports:", ", ".join(missing), file=sys.stderr)
        return 1
    if "contentHash" not in text or "assetPath" not in text:
        print("asset-store-core missing contentHash/assetPath fields", file=sys.stderr)
        return 1
    if "uniqueAssets" not in text or "duplicateRefs" not in text:
        print("asset-store-core missing dedupe stats", file=sys.stderr)
        return 1
    main_text = MAIN.read_text(encoding="utf-8")
    if "asset-store-core.js" not in main_text:
        print("main.js does not import asset-store-core", file=sys.stderr)
        return 1
    if "fileizeWorkspaceAssets" not in main_text or "prepareWorkspaceForPersistence" not in main_text:
        print("main.js does not wire fileize/prepare helpers", file=sys.stderr)
        return 1
    print("audit_asset_store: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
