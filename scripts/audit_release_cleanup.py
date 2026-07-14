from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
fails = []
for name in ("LICENSE", "NOTICE"):
    if not (ROOT / name).is_file():
        fails.append(f"missing {name}")
if fails:
    print("\n".join(fails))
    raise SystemExit(1)
print("audit_release_cleanup: ok")
