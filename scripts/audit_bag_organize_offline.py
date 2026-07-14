from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
core=(ROOT/"src"/"bag-organize-core.js").read_text(encoding="utf-8")
main=(ROOT/"src"/"main.js").read_text(encoding="utf-8")
fails=[]
for n in ["BAG_ORGANIZE_BLUEPRINT","assessBagOrganizeReadiness","item.target_material"]:
  if n not in core: fails.append("missing "+n)
if core.count("{ type:") < 10: fails.append("steps<10")
if "bag-organize-core.js" not in main: fails.append("main import missing")
if fails:
  print("\n".join(fails), file=sys.stderr); raise SystemExit(1)
print("audit_bag_organize_offline: ok")
