from __future__ import annotations
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ep = (ROOT / "scripts" / "execution_progress.py").read_text(encoding="utf-8")
    verifier = (ROOT / "scripts" / "verify_workspace_persistence.py").read_text(encoding="utf-8")
    main_js = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    failures = []
    if 'workspace-persistence-v1' not in ep:
        failures.append("execution_progress missing workspace-persistence-v1 allowlist")
    if 'VERIFIER_NAME = "workspace-persistence-v1"' not in verifier:
        failures.append("verifier name missing")
    if "double_read_equal" not in verifier or "atomic_write" not in verifier:
        failures.append("verifier missing atomic/double-read contracts")
    if "backup" not in main_js.lower() and "workspaceBackupPath" not in main_js:
        failures.append("main.js missing backup path surface")
    if "workspaceBackupPath" not in main_js:
        failures.append("main.js missing workspaceBackupPath")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("audit_workspace_persistence: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
