#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mhxy-persist-test-") as tmp:
        completed = subprocess.run(
            [sys.executable, "-B", str(ROOT / "scripts" / "verify_workspace_persistence.py"), "--work-dir", tmp, "--json", "--dry-run"],
            cwd=str(ROOT / "scripts"),
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            print(completed.stdout)
            print(completed.stderr, file=sys.stderr)
            return completed.returncode
        if "workspace-persistence-v1" not in completed.stdout:
            print("missing verifier name", file=sys.stderr)
            return 1
        print("test_verify_workspace_persistence: ok")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
