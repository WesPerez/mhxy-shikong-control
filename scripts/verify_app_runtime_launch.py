#!/usr/bin/env python3
"""Start and verify one owned current-commit controller app process."""

from __future__ import print_function

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import execution_progress as progress


VERIFIER_NAME = "current-app-launch-v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def process_creation_time_iso(pid: int) -> str:
    if os.name == "nt":
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-Process -Id {pid}).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')".format(pid=pid),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        value = completed.stdout.strip()
        if not value:
            raise RuntimeError("failed to read process creation time for pid {}".format(pid))
        return value
    # POSIX fallback
    stat = Path("/proc/{}/stat".format(pid))
    if not stat.exists():
        raise RuntimeError("process {} disappeared before creation-time capture".format(pid))
    return utc_now()


def process_command_line(pid: int) -> str:
    if os.name == "nt":
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\").CommandLine".format(pid=pid),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return (completed.stdout or "").strip()
    try:
        return Path("/proc/{}/cmdline".format(pid)).read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    except Exception:
        return ""


def process_is_running(pid: int) -> bool:
    if os.name == "nt":
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Process -Id {pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id".format(pid=pid)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return str(pid) in (completed.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def resolve_exe(path_text: str) -> Path:
    path = Path(path_text)
    if not path.is_absolute():
        path = (progress.ROOT / path).resolve()
    else:
        path = path.resolve()
    if not path.is_file():
        raise RuntimeError("controller exe is missing: {}".format(path))
    if path.name.lower() != "mhxy-shikong-control.exe" and "mhxy-shikong-control" not in path.name.lower():
        raise RuntimeError("refusing to launch unexpected binary name: {}".format(path.name))
    return path


def verify_and_launch(action_id: str, criterion_id: str, command_text: str, wait_seconds: float) -> Dict[str, Any]:
    with progress.ProgressLock(progress.progress_lock_path()):
        state = progress.load_json(progress.STATE_PATH)
        action = state.get("inFlightAction")
        if not action or action.get("actionId") != action_id:
            raise RuntimeError("matching in-flight process_start action not found")
        if action.get("kind") != "process_start" or action.get("status") != "running":
            raise RuntimeError("app launch verifier requires a running process_start action")
        if action.get("ownerRunId") != state.get("run", {}).get("runId"):
            raise RuntimeError("process_start action is not owned by the current run")
        lease_token = progress.load_action_token(action_id)
        progress.verify_external_action_lease(action_id, lease_token)

        ownership = action.get("ownershipEvidence") or []
        if len(ownership) < 2:
            raise RuntimeError("process_start ownershipEvidence requires at least two entries")

        ownership_map = {}
        for item in ownership:
            text_item = str(item)
            if "=" in text_item:
                key, value = text_item.split("=", 1)
                ownership_map[key.strip()] = value.strip()

        launch = action.get("launchIdentity") or {}
        exe_text = str(
            launch.get("exePath")
            or ownership_map.get("exePath")
            or action.get("targetIdentity")
            or ""
        )
        exe_path = resolve_exe(exe_text)
        expected_head = str(launch.get("expectedHead") or ownership_map.get("expectedHead") or "")
        observed_head = (state.get("git") or {}).get("observedHead")
        if expected_head and observed_head and expected_head != observed_head:
            raise RuntimeError(
                "launch expectedHead {} does not match observedHead {}".format(expected_head, observed_head)
            )
        expected_sha = str(launch.get("exeSha256") or ownership_map.get("exeSha256") or "").lower()
        actual_sha = file_sha256(exe_path)
        if expected_sha and expected_sha != actual_sha:
            raise RuntimeError("exe hash mismatch: expected {} got {}".format(expected_sha, actual_sha))

        cwd = Path(str(launch.get("cwd") or ownership_map.get("cwd") or progress.ROOT)).resolve()
        if not cwd.is_dir():
            raise RuntimeError("launch cwd is not a directory: {}".format(cwd))

        active_criteria = {
            item.get("id"): item for item in state.get("activeSlice", {}).get("acceptanceCriteria", [])
        }
        criterion = active_criteria.get(criterion_id)
        if not criterion or "app_runtime" not in criterion.get("requiredEvidenceCategories", []):
            raise RuntimeError("criterion is not an active app_runtime acceptance criterion")

        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        proc = subprocess.Popen(
            [str(exe_path)],
            cwd=str(cwd),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        pid = int(proc.pid)
        deadline = time.time() + max(1.0, float(wait_seconds))
        while time.time() < deadline:
            if process_is_running(pid):
                break
            time.sleep(0.2)
        if not process_is_running(pid):
            raise RuntimeError("controller process {} exited before observation window closed".format(pid))
        creation_time = process_creation_time_iso(pid)
        cmdline = process_command_line(pid)

        runtime = state.setdefault("runtime", {})
        managed = [
            item
            for item in runtime.get("managedProcesses", [])
            if int(item.get("pid", -1)) != pid
        ]
        managed_entry = {
            "pid": pid,
            "name": exe_path.name,
            "role": "controller-app",
            "exePath": str(exe_path),
            "cwd": str(cwd),
            "commandLine": cmdline,
            "creationTime": creation_time,
            "ownership": "task-owned",
            "ownershipEvidence": list(ownership)
            + [
                "verifier={}".format(VERIFIER_NAME),
                "exeSha256={}".format(actual_sha),
                "observedHead={}".format(observed_head),
                "actionId={}".format(action_id),
            ],
            "cleanupAllowed": True,
            "createdByRunId": state.get("run", {}).get("runId"),
            "createdByActionId": action_id,
            "createdAt": utc_now(),
            "present": True,
            "lastObservedAt": utc_now(),
        }
        managed.append(managed_entry)
        runtime["managedProcesses"] = managed
        runtime["observedAt"] = utc_now()
        observed = [
            item
            for item in runtime.get("observedExternalProcesses", [])
            if int(item.get("pid", -1)) != pid
        ]
        observed.append(
            {
                "pid": pid,
                "name": exe_path.name,
                "role": "controller-app",
                "ownership": "task-owned",
                "present": True,
                "creationTime": creation_time,
                "lastObservedAt": utc_now(),
                "lastSeenAt": utc_now(),
                "cleanupAllowed": False,
            }
        )
        runtime["observedExternalProcesses"] = observed
        fingerprint = (state.get("git") or {}).get("workingTreeFingerprint")
        progress.persist_transaction(state)

    report_dir = (
        progress.ROOT
        / "assets"
        / "resource"
        / "ShiKong"
        / "reports"
        / "dev-progress"
        / "app-runtime-{}".format(action_id)
    )
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "launch-report.json"
    verification = {
        "actionId": action_id,
        "verifier": VERIFIER_NAME,
        "pid": pid,
        "exePath": str(exe_path),
        "exeSha256": actual_sha,
        "cwd": str(cwd),
        "commandLine": cmdline,
        "creationTime": creation_time,
        "observedHead": observed_head,
        "workingTreeFingerprint": fingerprint,
        "ownershipEvidence": managed_entry["ownershipEvidence"],
    }
    report_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    evidence_args = argparse.Namespace(
        id=None,
        category="app_runtime",
        claim="Current-commit controller app launched and observed as task-owned process",
        status="passed",
        command=command_text,
        target_identity="controller-app:{}@{}".format(pid, exe_path.name),
        window_evidence_id=None,
        window_hwnd=None,
        window_pid=None,
        window_title=None,
        window_process=None,
        client_width=None,
        client_height=None,
        privilege=None,
        exit_code=0,
        criterion=[criterion_id],
        artifact=[str(report_path.relative_to(progress.ROOT)).replace("\\", "/"), str(exe_path)],
        input_sent=False,
        foreground_unchanged=None,
        cursor_unchanged=None,
        window_identity_verified=None,
        postcondition_observed=True,
        capture_method="specialized_verifier",
        runner_profile=None,
        verifier=VERIFIER_NAME,
        verification=verification,
    )
    evidence_id = progress.record_evidence(evidence_args, allow_passed=True)
    progress.command_action_finish(
        argparse.Namespace(
            action_id=action_id,
            status="succeeded",
            result="controller app launched pid={} exe={} evidence={}".format(pid, exe_path, evidence_id),
            verified_evidence_id=evidence_id,
        )
    )
    return {
        "evidenceId": evidence_id,
        "pid": pid,
        "exePath": str(exe_path),
        "reportPath": str(report_path),
    }



def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action-id", required=True)
    parser.add_argument("--criterion", required=True)
    parser.add_argument("--wait-seconds", type=float, default=8.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    command_text = "python -B scripts/verify_app_runtime_launch.py --action-id {} --criterion {}".format(
        args.action_id, args.criterion
    )
    result = verify_and_launch(args.action_id, args.criterion, command_text, args.wait_seconds)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["evidenceId"])
        print("pid={}".format(result["pid"]))
        print(result["exePath"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("app runtime launch verification failed: {}".format(exc), file=sys.stderr)
        sys.exit(1)
