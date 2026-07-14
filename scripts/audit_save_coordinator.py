#!/usr/bin/env python3
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[1]
failures = []
coord = (root / "src/save-coordinator-core.js").read_text(encoding="utf-8")
main = (root / "src/main.js").read_text(encoding="utf-8")
rust = (root / "src-tauri/src/main.rs").read_text(encoding="utf-8")
mig = (root / "src/workspace-migration-core.js").read_text(encoding="utf-8")
if "createSaveCoordinator" not in coord:
    failures.append("save coordinator missing createSaveCoordinator")
if "createSaveCoordinator" not in main:
    failures.append("main.js does not import/use save coordinator")
if "saveCoordinator.schedule" not in main and "state.saveCoordinator" not in main:
    failures.append("main.js does not schedule via save coordinator")
if "atomic_write_workspace_json" not in rust:
    failures.append("rust atomic workspace write missing")
if "futureSchema" not in mig and "future_schema" not in mig:
    failures.append("migration core missing future schema handling")
if failures:
    print({"ok": False, "failures": failures})
    sys.exit(1)
print({"ok": True, "checked": ["save-coordinator-core.js", "main.js schedule", "rust atomic write", "future schema"]})
