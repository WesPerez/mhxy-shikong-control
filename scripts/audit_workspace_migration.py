#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def audit() -> dict[str, object]:
    failures: list[str] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}

    required_files = [
        "src/workspace-migration-core.js",
        "scripts/test_workspace_migration_core.mjs",
        "src/main.js",
        "src-tauri/src/main.rs",
        "index.html",
        "package.json",
        "docs/workflow-model.md",
        "docs/product-plan.md",
        "README.md",
    ]
    for item in required_files:
        if not (ROOT / item).is_file():
            failures.append(f"missing {item}")
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "counts": counts}

    core = read_text("src/workspace-migration-core.js")
    test = read_text("scripts/test_workspace_migration_core.mjs")
    main = read_text("src/main.js")
    rust = read_text("src-tauri/src/main.rs")
    html = read_text("index.html")
    package = json.loads(read_text("package.json"))
    docs = "\n".join(
        [
            read_text("README.md"),
            read_text("docs/workflow-model.md"),
            read_text("docs/product-plan.md"),
        ]
    )

    for needle in [
        "workspaceMigrationAudit",
        "workspaceMigrationSummaryText",
        "countAssignmentQueueItems",
        "legacyAssetsMigrated",
        "runHistoryTrimmed",
        "droppedQueueItems",
    ]:
        if needle not in core:
            failures.append(f"workspace migration core missing {needle}")

    for needle in [
        "testMigrationAuditFlagsLegacyWorkspaceNormalization",
        "testMigrationAuditRecognizesStableWorkspace",
        "testMigrationAuditWarnsOnFutureSchema",
        "workspaceMigrationSummaryText",
    ]:
        if needle not in test:
            failures.append(f"workspace migration test missing {needle}")

    for needle in [
        "workspaceMigrationAudit(",
        "state.workspaceMigration",
        "state.workspaceBackupPath",
        "renderWorkspaceMigrationAudit",
        "state.workspaceMigration.shouldSave",
        "result.backupPath",
    ]:
        if needle not in main:
            failures.append(f"src/main.js missing {needle}")

    if 'id="workspace-migration"' not in html:
        failures.append("index.html missing workspace-migration status line")

    for needle in [
        "backup_path: Option<String>",
        "backup_path: backup_path.map",
        "atomic_write_workspace_json(&path, text.as_bytes())?",
        "workspace_json_write_replaces_file_and_keeps_backup",
    ]:
        if needle not in rust:
            failures.append(f"Rust workspace persistence missing {needle}")

    scripts = package.get("scripts", {})
    if scripts.get("test:workspace-migration") != "node scripts/test_workspace_migration_core.mjs":
        failures.append("package.json missing test:workspace-migration script")
    if scripts.get("audit:workspace-migration") != "python scripts/audit_workspace_migration.py":
        failures.append("package.json missing audit:workspace-migration script")

    for needle in ["迁移审计", "workspace.json.bak", "schema v9"]:
        if needle not in docs:
            failures.append(f"docs missing {needle}")

    counts["main_workspace_migration_mentions"] = len(re.findall(r"workspaceMigration", main))
    counts["core_actions"] = len(re.findall(r'actions\.push\(', core))
    return {"passed": not failures, "failures": failures, "warnings": warnings, "counts": counts}


def main() -> int:
    result = audit()
    if "--json" in sys.argv:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["passed"]:
        print("workspace migration audit passed")
    else:
        print("workspace migration audit failed", file=sys.stderr)
        for failure in result["failures"]:
            print(f"- {failure}", file=sys.stderr)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
