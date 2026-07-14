#!/usr/bin/env python3
"""Single-writer helper for long-running development progress state.

This tool intentionally manages only repository-local continuity metadata. It
does not start applications, send input, stop processes, clean artifacts, or
change Git history.
"""

from __future__ import print_function

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT = Path(__file__).resolve().parents[1]
EXECUTION_DIR = ROOT / "docs" / "execution"
STATE_PATH = EXECUTION_DIR / "state.json"
STATUS_PATH = EXECUTION_DIR / "STATUS.md"
EVENTS_PATH = EXECUTION_DIR / "events.jsonl"
EVIDENCE_PATH = EXECUTION_DIR / "evidence.jsonl"
CHECKPOINT_DIR = EXECUTION_DIR / "checkpoints"
EXTERNAL_LEASE_PATH = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "MHXY-ShiKong-Control" / "codex-external-action-lease.json"

EVENT_TYPES = {
    "session_start",
    "session_end",
    "decision",
    "scope_change",
    "slice_started",
    "slice_state_changed",
    "action_intent",
    "action_result",
    "test_run",
    "runtime_observation",
    "evidence_recorded",
    "blocker",
    "reconciliation",
    "checkpoint",
    "commit",
    "push",
}
ACTION_STATUSES = {
    "none",
    "planned",
    "running",
    "succeeded",
    "failed",
    "unknown_after_interruption",
}
PHASE_STATUSES = {"pending", "in_progress", "verifying", "verified", "blocked"}
CRITERION_STATUSES = {"pending", "passed", "failed", "blocked", "not_required"}
GATE_STATUSES = {
    "pending",
    "partial",
    "passed",
    "failed",
    "blocked",
    "not_required",
    "stale",
    "outdated",
    "not_verified",
}
EVIDENCE_STATUSES = {"observed", "passed", "failed", "blocked", "preflight"}
EVIDENCE_CATEGORIES = {
    "source_audit",
    "test",
    "build",
    "app_runtime",
    "runtime_observation",
    "window_identity",
    "live_preflight",
    "live_input",
    "live_outcome",
    "multi_window",
    "persistence",
    "appdata_backup",
    "failure_reproduction",
    "cleanup_audit",
}
PROFILE_EVIDENCE_CATEGORIES = {"source_audit", "test", "build", "cleanup_audit"}
SPECIALIZED_EVIDENCE_CATEGORIES = {"app_runtime", "window_identity", "live_preflight", "live_input", "live_outcome", "multi_window", "persistence", "appdata_backup"}
PROFILE_CATEGORY_BY_NAME = {
    "node-all": "test",
    "python-audits": "test",
    "frontend-build": "build",
    "rust-static": "test",
    "p0-preflight": "source_audit",
    "home-vitality-offline": "source_audit",
    "save-coordinator-offline": "source_audit",
    "asset-store-offline": "source_audit",
    "workspace-persistence-offline": "source_audit",
    "welfare-sign-in-offline": "source_audit",
    "bag-organize-offline": "source_audit",
    "p0-safety-boundary": "cleanup_audit",
    "ui-viewports": "test",
}
SPECIALIZED_VERIFIER_ALLOWLIST: Dict[str, set] = {
    "app_runtime": {"current-app-launch-v1"},
    "window_identity": {"window-identity-v1"},
    "live_preflight": {"strict-capture-preflight-v1"},
    "live_input": {"bounded-live-input-v1"},
    "live_outcome": {"bounded-live-input-v1"},
    "multi_window": set(),
    "persistence": {"workspace-persistence-v1"},
    "appdata_backup": {"p0-workspace-backup-v1"},
}
ACTION_KINDS = {
    "appdata_backup",
    "appdata_write",
    "appdata_migration",
    "git_commit",
    "git_push",
    "process_start",
    "process_stop",
    "file_create",
    "file_delete",
    "config_change",
    "game_hotkey",
    "game_text_input",
    "game_click",
    "game_double_click",
    "game_image_click",
}
SIDE_EFFECT_CLASSES = {
    "local_file_create",
    "local_file_delete",
    "appdata_write",
    "appdata_migration",
    "git_commit",
    "git_push",
    "process_start",
    "process_stop",
    "config_change",
    "game_input",
}
GAME_ACTION_KINDS = {
    "game_hotkey",
    "game_text_input",
    "game_click",
    "game_double_click",
    "game_image_click",
}
ACTION_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._-]{2,63}$")
ACTION_CLASS_BY_KIND = {
    "appdata_backup": "local_file_create",
    "appdata_write": "appdata_write",
    "appdata_migration": "appdata_migration",
    "git_commit": "git_commit",
    "git_push": "git_push",
    "process_start": "process_start",
    "process_stop": "process_stop",
    "file_create": "local_file_create",
    "file_delete": "local_file_delete",
    "config_change": "config_change",
    "game_hotkey": "game_input",
    "game_text_input": "game_input",
    "game_click": "game_input",
    "game_double_click": "game_input",
    "game_image_click": "game_input",
}
MACHINE_LEASE_ACTION_KINDS = {
    "appdata_backup",
    "appdata_write",
    "appdata_migration",
    "process_stop",
    "process_start",
    "git_push",
    "config_change",
    "game_hotkey",
    "game_text_input",
    "game_click",
    "game_double_click",
    "game_image_click",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def object_hash(value: Dict[str, Any]) -> str:
    payload = dict(value)
    payload.pop("hash", None)
    return "sha256:" + hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("{} must contain a JSON object".format(path))
    return value


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    if not path.exists():
        return records
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError("{}:{} invalid JSON: {}".format(path, line_number, exc))
            if not isinstance(value, dict):
                raise ValueError("{}:{} must contain a JSON object".format(path, line_number))
            records.append(value)
    return records


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, str(path))
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, str(path))
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(temp_name)
        raise


def atomic_write_json(path: Path, value: Dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def action_token_path(action_id: str) -> Path:
    if not ACTION_ID_PATTERN.fullmatch(action_id):
        raise RuntimeError("actionId must match {}".format(ACTION_ID_PATTERN.pattern))
    raw_root = run_git("rev-parse", "--git-path", "codex-action-tokens")
    token_root = Path(raw_root)
    if not token_root.is_absolute():
        token_root = ROOT / token_root
    token_root = token_root.resolve()
    path = (token_root / "{}.token".format(action_id)).resolve()
    if path.parent != token_root:
        raise RuntimeError("action token path escaped the Git token directory")
    return path


def create_action_token(action_id: str) -> str:
    token = secrets.token_hex(32)
    path = action_token_path(action_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="ascii", newline="\n") as handle:
        handle.write(token + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return token


def load_action_token(action_id: str) -> Optional[str]:
    path = action_token_path(action_id)
    if not path.exists():
        return None
    return path.read_text(encoding="ascii").strip()


def delete_action_token(action_id: str) -> None:
    path = action_token_path(action_id)
    if path.exists():
        path.unlink()


def create_external_action_lease(action: Dict[str, Any], state: Dict[str, Any], lease_token: str) -> None:
    EXTERNAL_LEASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    lease = {
        "kind": "mhxy-shikong.external-action-lease",
        "schemaVersion": 1,
        "createdAt": utc_now(),
        "repository": str(ROOT),
        "runId": state.get("run", {}).get("runId"),
        "action": action,
        "leaseTokenHash": hashlib.sha256(lease_token.encode("utf-8")).hexdigest(),
    }
    try:
        with EXTERNAL_LEASE_PATH.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(lease, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        raise RuntimeError("another worktree/clone has an unresolved machine-level external action lease: {}".format(EXTERNAL_LEASE_PATH))


def load_external_action_lease() -> Optional[Dict[str, Any]]:
    if not EXTERNAL_LEASE_PATH.exists():
        return None
    return load_json(EXTERNAL_LEASE_PATH)


def verify_external_action_lease(action_id: str, lease_token: Optional[str]) -> Dict[str, Any]:
    lease = load_external_action_lease()
    if not lease:
        raise RuntimeError("machine-level external action lease is missing")
    if lease.get("action", {}).get("actionId") != action_id:
        raise RuntimeError("machine-level external action lease belongs to another action")
    if not lease_token or hashlib.sha256(lease_token.encode("utf-8")).hexdigest() != lease.get("leaseTokenHash"):
        raise RuntimeError("machine-level external action lease token is unavailable or invalid; foreign takeover is forbidden")
    return lease


def release_external_action_lease(action_id: str, lease_token: Optional[str]) -> None:
    verify_external_action_lease(action_id, lease_token)
    EXTERNAL_LEASE_PATH.unlink()


def public_action(action: Dict[str, Any]) -> Dict[str, Any]:
    return dict(action)


def append_jsonl(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = canonical_json(value) + "\n"
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())


class ProgressLock:
    def __init__(self, path: Path, timeout_seconds: float = 10.0) -> None:
        self.path = path
        self.timeout_seconds = timeout_seconds
        self.handle = None

    def __enter__(self) -> "ProgressLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"0")
            self.handle.flush()
        deadline = time.time() + self.timeout_seconds
        while True:
            try:
                self.handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, IOError):
                if time.time() >= deadline:
                    self.handle.close()
                    self.handle = None
                    raise RuntimeError("timed out waiting for progress writer lock")
                time.sleep(0.1)

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.handle is None:
            return
        self.handle.seek(0)
        if os.name == "nt":
            import msvcrt

            with contextlib.suppress(OSError):
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            with contextlib.suppress(OSError):
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()
        self.handle = None


def run_git(*args: str) -> str:
    completed = subprocess.run(
        ["git"] + list(args),
        cwd=str(ROOT),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout.rstrip("\r\n")


def progress_lock_path() -> Path:
    raw_path = run_git("rev-parse", "--git-path", "codex-execution.lock")
    path = Path(raw_path)
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def current_git_snapshot() -> Dict[str, Any]:
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=str(ROOT),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    tokens = completed.stdout.decode("utf-8", errors="surrogateescape").split("\0")
    status_lines: List[str] = []
    dirty_paths: List[str] = []
    dirty_entries: List[Dict[str, Any]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not token:
            index += 1
            continue
        if len(token) < 3:
            raise ValueError("invalid git porcelain record")
        status = token[:2]
        path = token[3:]
        if "R" in status or "C" in status:
            if index + 1 >= len(tokens) or not tokens[index + 1]:
                raise ValueError("git porcelain rename/copy record is missing its source path")
            original_path = tokens[index + 1]
            display_path = "{} -> {}".format(original_path, path)
            entry = {"status": status, "sourcePath": original_path, "destinationPath": path, "displayPath": display_path}
            index += 2
        else:
            display_path = path
            entry = {"status": status, "sourcePath": None, "destinationPath": path, "displayPath": display_path}
            index += 1
        dirty_paths.append(display_path)
        dirty_entries.append(entry)
        status_lines.append("{} {}".format(status, display_path))
    dirty_paths.sort()
    status_lines.sort(key=lambda item: item[3:] if len(item) > 3 else item)
    dirty_entries.sort(key=lambda item: item["displayPath"])
    try:
        upstream_head = run_git("rev-parse", "origin/main")
    except subprocess.CalledProcessError:
        upstream_head = None
    try:
        branch = run_git("branch", "--show-current")
    except subprocess.CalledProcessError:
        branch = ""
    dirty_files: List[Dict[str, Any]] = []
    for display_path in dirty_paths:
        candidate_text = display_path.split(" -> ", 1)[-1]
        candidate = ROOT / candidate_text
        item: Dict[str, Any] = {"path": display_path, "exists": candidate.exists()}
        if candidate.is_file():
            item.update({"sha256": file_sha256(candidate), "size": candidate.stat().st_size})
        dirty_files.append(item)
    snapshot = {
        "branch": branch or "DETACHED",
        "observedHead": run_git("rev-parse", "HEAD"),
        "upstreamHead": upstream_head,
        "dirtyPaths": dirty_paths,
        "dirtyStatus": status_lines,
        "dirtyEntries": dirty_entries,
        "dirtyFiles": dirty_files,
    }
    product_display_paths = {entry["displayPath"] for entry in dirty_entries if not dirty_entry_is_execution_metadata(entry)}
    source_status = [item for item in snapshot["dirtyStatus"] if (item[3:] if len(item) > 3 else item) in product_display_paths]
    source_files = [item for item in snapshot["dirtyFiles"] if item.get("path") in product_display_paths]
    fingerprint_payload = {
        "branch": snapshot["branch"],
        "observedHead": snapshot["observedHead"],
        "upstreamHead": snapshot["upstreamHead"],
        "dirtyStatus": source_status,
        "dirtyFiles": source_files,
    }
    snapshot["workingTreeFingerprint"] = "sha256:" + hashlib.sha256(canonical_json(fingerprint_payload).encode("utf-8")).hexdigest()
    return snapshot


def path_is_execution_metadata(path: Optional[str]) -> bool:
    if not path:
        return True
    return path.replace("\\", "/").startswith("docs/execution/")


def dirty_entry_is_execution_metadata(entry: Dict[str, Any]) -> bool:
    return path_is_execution_metadata(entry.get("sourcePath")) and path_is_execution_metadata(entry.get("destinationPath"))


def non_metadata_dirty_paths(snapshot: Dict[str, Any]) -> List[str]:
    entries = snapshot.get("dirtyEntries", [])
    if entries:
        return [entry.get("displayPath") for entry in entries if not dirty_entry_is_execution_metadata(entry)]
    result = []
    for display_path in snapshot.get("dirtyPaths", []):
        if " -> " in display_path:
            source_path, destination_path = display_path.split(" -> ", 1)
            if not (path_is_execution_metadata(source_path) and path_is_execution_metadata(destination_path)):
                result.append(display_path)
        elif not path_is_execution_metadata(display_path):
            result.append(display_path)
    return result


def refresh_state_runtime_fields(state: Dict[str, Any]) -> None:
    snapshot = current_git_snapshot()
    state.setdefault("git", {}).update(snapshot)
    state["updatedAt"] = utc_now()
    state["revision"] = int(state.get("revision", 0)) + 1


def next_ledger_record(
    path: Path,
    kind: str,
    record_id: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    records = load_jsonl(path)
    previous_hash = None
    for expected_seq, record in enumerate(records, 1):
        if record.get("kind") != kind or record.get("seq") != expected_seq:
            raise RuntimeError("{} contains an invalid record sequence".format(path.name))
        if record.get("prevHash") != previous_hash or record.get("hash") != object_hash(record):
            raise RuntimeError("{} hash chain is invalid; reconcile before appending".format(path.name))
        previous_hash = record.get("hash")
    previous = records[-1] if records else None
    record = {
        "kind": kind,
        "schemaVersion": 1,
        "seq": int(previous["seq"]) + 1 if previous else 1,
        "id": record_id,
        "prevHash": previous.get("hash") if previous else None,
    }
    record.update(payload)
    record["hash"] = object_hash(record)
    return record


def update_tail(state: Dict[str, Any], key: str, record: Dict[str, Any]) -> None:
    state[key] = {"seq": record["seq"], "id": record["id"], "hash": record["hash"]}


def current_session(state: Dict[str, Any]) -> Tuple[str, int]:
    run = state.get("run", {})
    return str(run.get("runId", "unknown-run")), int(run.get("attempt", 1))


def create_event(
    state: Dict[str, Any],
    event_type: str,
    summary: str,
    details: Optional[Dict[str, Any]] = None,
    evidence_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    if event_type not in EVENT_TYPES:
        raise ValueError("unsupported event type: {}".format(event_type))
    run_id, attempt = current_session(state)
    active = state.get("activeSlice") or {}
    next_seq = len(load_jsonl(EVENTS_PATH)) + 1
    event_id = "EVT-{:04d}".format(next_seq)
    payload = {
        "timestamp": utc_now(),
        "runId": run_id,
        "attempt": attempt,
        "actor": "primary-agent",
        "eventType": event_type,
        "phaseId": state.get("currentPhaseId"),
        "sliceId": active.get("id"),
        "summary": summary,
        "details": details or {},
        "git": {
            "observedHead": state.get("git", {}).get("observedHead"),
            "dirtyPaths": state.get("git", {}).get("dirtyPaths", []),
        },
        "evidenceIds": evidence_ids or [],
    }
    return next_ledger_record(EVENTS_PATH, "mhxy-shikong.execution-event", event_id, payload)


def persist_transaction(
    state: Dict[str, Any],
    event: Optional[Dict[str, Any]] = None,
    evidence: Optional[Dict[str, Any]] = None,
) -> None:
    if evidence is not None:
        append_jsonl(EVIDENCE_PATH, evidence)
        update_tail(state, "evidenceTail", evidence)
    if event is not None:
        append_jsonl(EVENTS_PATH, event)
        update_tail(state, "eventTail", event)
    atomic_write_json(STATE_PATH, state)
    events = load_jsonl(EVENTS_PATH)
    evidence_records = load_jsonl(EVIDENCE_PATH)
    atomic_write_text(STATUS_PATH, render_status(state, events, evidence_records))
    final_snapshot = current_git_snapshot()
    snapshot_keys = {"branch", "observedHead", "upstreamHead", "dirtyPaths", "dirtyStatus", "dirtyEntries", "dirtyFiles", "workingTreeFingerprint"}
    if any(state.get("git", {}).get(key) != final_snapshot.get(key) for key in snapshot_keys):
        state.setdefault("git", {}).update(final_snapshot)
        atomic_write_json(STATE_PATH, state)
        atomic_write_text(STATUS_PATH, render_status(state, events, evidence_records))


def format_gate(value: Dict[str, Any]) -> str:
    status = value.get("status", "pending")
    labels = {
        "pending": "待验证",
        "partial": "部分",
        "passed": "已通过",
        "failed": "失败",
        "blocked": "阻塞",
        "not_required": "不要求",
        "stale": "已过期",
        "outdated": "版本过旧",
        "not_verified": "未验证",
    }
    return labels.get(status, status)


def markdown_list(items: Iterable[str], empty: str = "none") -> str:
    values = list(items)
    if not values:
        return "- {}\n".format(empty)
    return "".join("- {}\n".format(md_cell(item)) for item in values)


def status_state_digest(state: Dict[str, Any]) -> str:
    encoded = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def md_cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>").replace("\r", "<br>")


def parse_utc_timestamp(value: Any) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("timestamp must be UTC and end with Z")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def runtime_freshness(state: Dict[str, Any], now: Optional[dt.datetime] = None) -> Dict[str, Any]:
    runtime = state.get("runtime", {})
    observed_at = runtime.get("observedAt")
    stale_after = int(runtime.get("staleAfterSeconds", 300))
    current = now or dt.datetime.now(dt.timezone.utc)
    try:
        observed = parse_utc_timestamp(observed_at)
        age_seconds = max(0, int((current - observed).total_seconds()))
        expires_at = observed + dt.timedelta(seconds=stale_after)
        return {
            "status": "fresh" if age_seconds <= stale_after else "stale",
            "observedAt": observed_at,
            "ageSeconds": age_seconds,
            "staleAfterSeconds": stale_after,
            "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        }
    except Exception as exc:
        return {
            "status": "invalid",
            "observedAt": observed_at,
            "ageSeconds": None,
            "staleAfterSeconds": stale_after,
            "expiresAt": None,
            "error": str(exc),
        }


def evidence_applicability(record: Dict[str, Any], state: Dict[str, Any]) -> Tuple[str, str]:
    if record.get("status") != "passed":
        return "not_passed", "命令/观察结果不是 passed"
    if not evidence_provenance_valid(record):
        return "legacy_or_invalid", "来源不是受信 profile 或专用 verifier"
    record_git = record.get("git", {})
    state_git = state.get("git", {})
    if record_git.get("observedHead") != state_git.get("observedHead"):
        return "stale", "证据 HEAD 与当前 observed HEAD 不同"
    if record.get("category") != "appdata_backup" and record_git.get("workingTreeFingerprint") != state_git.get("workingTreeFingerprint"):
        return "stale", "证据工作树指纹与当前现场不同"
    for artifact in record.get("artifacts", []):
        raw_path = artifact.get("path")
        if not raw_path:
            return "invalid", "证据产物缺少路径"
        path = Path(raw_path)
        absolute = path if path.is_absolute() else ROOT / path
        if not absolute.is_file():
            return "invalid", "证据产物不存在：{}".format(raw_path)
        expected_hash = artifact.get("sha256")
        if expected_hash and file_sha256(absolute) != expected_hash:
            return "invalid", "证据产物 hash 已变化：{}".format(raw_path)
    return "valid", "绑定当前 HEAD、工作树指纹和受信来源"


def validate_ledger_snapshot(records: List[Dict[str, Any]], kind: str, label: str) -> List[str]:
    errors: List[str] = []
    previous_hash = None
    seen_ids = set()
    for expected_seq, record in enumerate(records, 1):
        if record.get("kind") != kind:
            errors.append("{} seq {} kind 无效".format(label, record.get("seq")))
        if record.get("seq") != expected_seq:
            errors.append("{} 序号不连续：期望 {}，实际 {}".format(label, expected_seq, record.get("seq")))
        if record.get("id") in seen_ids:
            errors.append("{} 包含重复 id {}".format(label, record.get("id")))
        seen_ids.add(record.get("id"))
        if record.get("prevHash") != previous_hash:
            errors.append("{} seq {} prevHash 不匹配".format(label, record.get("seq")))
        if record.get("hash") != object_hash(record):
            errors.append("{} seq {} hash 不匹配".format(label, record.get("seq")))
        previous_hash = record.get("hash")
    return errors


def expected_ledger_tail(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not records:
        return {"seq": 0, "id": None, "hash": None}
    record = records[-1]
    return {"seq": record.get("seq"), "id": record.get("id"), "hash": record.get("hash")}


def file_identity(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {"exists": False}
    stat = path.stat()
    return {
        "exists": True,
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "sha256": file_sha256(path),
    }


def continuity_input_signature(state: Dict[str, Any]) -> Dict[str, Any]:
    paths = {
        "state": STATE_PATH,
        "status": STATUS_PATH,
        "events": EVENTS_PATH,
        "evidence": EVIDENCE_PATH,
        "externalLease": EXTERNAL_LEASE_PATH,
    }
    checkpoint_path = (state.get("lastCheckpoint") or {}).get("path")
    if checkpoint_path:
        paths["checkpoint"] = ROOT / checkpoint_path
    return {name: file_identity(path) for name, path in paths.items()}


def build_resume_report() -> Dict[str, Any]:
    state = load_json(STATE_PATH)
    signature_before = continuity_input_signature(state)
    state = load_json(STATE_PATH)
    events = load_jsonl(EVENTS_PATH)
    evidence = load_jsonl(EVIDENCE_PATH)
    snapshot = current_git_snapshot()
    errors = validate_ledger_snapshot(events, "mhxy-shikong.execution-event", "events")
    errors.extend(validate_ledger_snapshot(evidence, "mhxy-shikong.execution-evidence", "evidence"))
    if state.get("eventTail") != expected_ledger_tail(events):
        errors.append("state.eventTail 与 events 末尾不一致")
    if state.get("evidenceTail") != expected_ledger_tail(evidence):
        errors.append("state.evidenceTail 与 evidence 末尾不一致")
    evidence_by_id = {record.get("id"): record for record in evidence}
    for gate_name, gate in state.get("projectVerification", {}).items():
        if gate.get("status") == "passed" and not any(
            evidence_satisfies_gate(gate_name, evidence_by_id.get(evidence_id, {}), state)
            for evidence_id in gate.get("evidenceIds", [])
        ):
            errors.append("passed gate {} 缺少当前语义有效证据".format(gate_name))
    for criterion in state.get("activeSlice", {}).get("acceptanceCriteria", []):
        if criterion.get("status") == "passed" and not any(
            evidence_satisfies_criterion(criterion, evidence_by_id.get(evidence_id, {}), state)
            for evidence_id in criterion.get("evidenceIds", [])
        ):
            errors.append("passed criterion {} 缺少当前语义有效证据".format(criterion.get("id")))

    status_text = STATUS_PATH.read_text(encoding="utf-8") if STATUS_PATH.is_file() else ""
    expected_digest = "<!-- state-digest: {} -->".format(status_state_digest(state))
    if expected_digest not in status_text:
        errors.append("STATUS.md 不是当前 state.json 的投影")
    elif status_text != render_status(state, events, evidence):
        errors.append("STATUS.md 不是当前 state/账本的精确投影")

    checkpoint_state = state.get("lastCheckpoint") or {}
    checkpoint_status = "none"
    if checkpoint_state:
        raw_path = checkpoint_state.get("path")
        checkpoint_path = ROOT / raw_path if raw_path else None
        if not checkpoint_path or not checkpoint_path.is_file():
            errors.append("最新 checkpoint 文件不存在")
            checkpoint_status = "missing"
        else:
            checkpoint = load_json(checkpoint_path)
            expected_checkpoint_hash = object_hash(checkpoint)
            if checkpoint.get("hash") != expected_checkpoint_hash:
                errors.append("最新 checkpoint 自哈希无效")
                checkpoint_status = "invalid"
            elif checkpoint_state.get("hash") != checkpoint.get("hash"):
                errors.append("state.lastCheckpoint.hash 与 checkpoint 不一致")
                checkpoint_status = "invalid"
            else:
                checkpoint_status = "ok"

    lease = load_external_action_lease()
    lease_status = "none"
    owner_token_present = False
    owner_token_matches = False
    lease_action = (lease or {}).get("action") or {}
    if lease:
        lease_status = "ok"
        if lease.get("kind") != "mhxy-shikong.external-action-lease" or lease.get("schemaVersion") != 1:
            errors.append("机器级 external lease kind/schemaVersion 无效")
            lease_status = "invalid"
        try:
            if Path(str(lease.get("repository"))).resolve() != ROOT.resolve():
                errors.append("机器级 external lease 属于其他仓库")
                lease_status = "invalid"
        except Exception:
            errors.append("机器级 external lease repository 无效")
            lease_status = "invalid"
        action_id = lease_action.get("actionId")
        if not isinstance(action_id, str) or not ACTION_ID_PATTERN.fullmatch(action_id):
            errors.append("机器级 external lease actionId 无效")
            lease_status = "invalid"
        else:
            token = load_action_token(action_id)
            owner_token_present = bool(token)
            owner_token_matches = bool(token) and hashlib.sha256(token.encode("utf-8")).hexdigest() == lease.get("leaseTokenHash")

    action = state.get("inFlightAction") or None
    if action and lease and action.get("actionId") != lease_action.get("actionId"):
        errors.append("state 未决动作与机器级 lease 不一致")
    state_git = state.get("git", {})
    workspace_drift = any(
        snapshot.get(key) != state_git.get(key)
        for key in ("observedHead", "upstreamHead", "workingTreeFingerprint")
    )
    freshness = runtime_freshness(state)
    unresolved = bool(action) or bool(lease)
    if errors:
        decision = "blocked"
    elif unresolved or workspace_drift:
        decision = "reconciliation_required"
    else:
        decision = "safe_to_resume"
    checkpoint_safe = bool(checkpoint_state.get("safeToResume"))
    live_safe = (
        decision == "safe_to_resume"
        and bool(checkpoint_state.get("safeToRunLiveInput"))
        and freshness.get("status") == "fresh"
        and state_git.get("observedHead") == state_git.get("verifiedHead")
        and not non_metadata_dirty_paths(snapshot)
    )
    effective_next_action = (
        "对账未决副作用动作 {}；结果明确前禁止重放".format((action or lease_action).get("actionId"))
        if unresolved
        else state.get("activeSlice", {}).get("nextAction")
    )
    report = {
        "kind": "mhxy-shikong.resume-check",
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "decision": decision,
        "integrityErrors": errors,
        "workspaceDrift": workspace_drift,
        "snapshot": {
            "stateRevision": state.get("revision"),
            "eventTail": expected_ledger_tail(events),
            "evidenceTail": expected_ledger_tail(evidence),
            "observedHead": snapshot.get("observedHead"),
            "verifiedHead": state_git.get("verifiedHead"),
            "upstreamHead": snapshot.get("upstreamHead"),
            "workingTreeFingerprint": snapshot.get("workingTreeFingerprint"),
            "checkpointId": checkpoint_state.get("id"),
            "checkpointStatus": checkpoint_status,
            "leaseStatus": lease_status,
            "inputHashes": {name: value.get("sha256") for name, value in signature_before.items() if value.get("exists")},
        },
        "activeSlice": {
            "phaseId": state.get("currentPhaseId"),
            "sliceId": state.get("activeSlice", {}).get("id"),
            "title": state.get("activeSlice", {}).get("title"),
            "effectiveNextAction": effective_next_action,
        },
        "action": {
            "status": (action or {}).get("status", "none"),
            "actionId": (action or lease_action).get("actionId"),
            "kind": (action or lease_action).get("kind"),
            "ownerTokenPresent": owner_token_present,
            "ownerTokenMatches": owner_token_matches,
        },
        "runtimeFreshness": freshness,
        "permissions": {
            "canRunReadOnlyChecks": True,
            "canResumeMetadata": not errors,
            "canContinueCodeWork": decision == "safe_to_resume" and checkpoint_safe,
            "canStartSideEffect": False,
            "requiresActionSpecificGate": True,
            "canRunLiveInput": live_safe,
        },
        "prohibitedActions": [
            "未通过动作专用门禁前不得写 AppData、启动/停止进程、commit/push 或清理",
            "未决副作用结果不明时不得重放",
            "safeToRunLiveInput、窗口身份、权限和运行现场任一无效时不得发送游戏输入",
        ],
    }
    signature_after = continuity_input_signature(state)
    if signature_before != signature_after:
        report["integrityErrors"].append("resume-check 读取期间连续性文件发生变化；可能存在并发 writer")
        report["decision"] = "blocked"
        report["permissions"]["canResumeMetadata"] = False
        report["permissions"]["canContinueCodeWork"] = False
        report["permissions"]["canStartSideEffect"] = False
        report["permissions"]["canRunLiveInput"] = False
    check_payload = dict(report)
    check_payload.pop("generatedAt", None)
    report["checkId"] = "sha256:" + hashlib.sha256(canonical_json(check_payload).encode("utf-8")).hexdigest()
    return report


def command_resume_check(args: argparse.Namespace) -> int:
    try:
        report = build_resume_report()
    except Exception as exc:
        error = "resume-check 无法解析或读取连续性现场：{}".format(exc)
        report = {
            "kind": "mhxy-shikong.resume-check",
            "schemaVersion": 1,
            "generatedAt": utc_now(),
            "decision": "blocked",
            "integrityErrors": [error],
            "workspaceDrift": None,
            "snapshot": {},
            "activeSlice": {"phaseId": None, "sliceId": None, "title": None, "effectiveNextAction": "先修复/隔离损坏的连续性数据，禁止副作用"},
            "action": {"status": "unknown", "actionId": None, "kind": None, "ownerTokenPresent": False, "ownerTokenMatches": False},
            "runtimeFreshness": {"status": "unknown", "ageSeconds": None, "staleAfterSeconds": None},
            "permissions": {
                "canRunReadOnlyChecks": True,
                "canResumeMetadata": False,
                "canContinueCodeWork": False,
                "canStartSideEffect": False,
                "requiresActionSpecificGate": True,
                "canRunLiveInput": False,
            },
            "prohibitedActions": ["连续性数据无法解析时禁止任何副作用动作"],
        }
        report["checkId"] = "sha256:" + hashlib.sha256(canonical_json({"decision": "blocked", "error": error}).encode("utf-8")).hexdigest()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        decision_labels = {
            "safe_to_resume": "可恢复",
            "reconciliation_required": "需要先对账/刷新现场",
            "blocked": "阻塞，禁止副作用",
        }
        freshness = report.get("runtimeFreshness", {})
        action = report.get("action", {})
        print("恢复结论：{}".format(decision_labels.get(report.get("decision"), report.get("decision"))))
        print("checkId：{}".format(report.get("checkId")))
        print("停点：{} / {} - {}".format(report["activeSlice"].get("phaseId"), report["activeSlice"].get("sliceId"), report["activeSlice"].get("title")))
        print("未决动作：{} ({})".format(action.get("actionId") or "none", action.get("status")))
        print("运行现场：{}；年龄={}s；TTL={}s".format(freshness.get("status"), freshness.get("ageSeconds"), freshness.get("staleAfterSeconds")))
        print("工作树漂移：{}".format(str(report.get("workspaceDrift")).lower()))
        print("下一动作：{}".format(report["activeSlice"].get("effectiveNextAction") or "none"))
        permissions = report.get("permissions", {})
        print("允许：只读={}，代码工作={}，副作用={}，真实输入={}".format(
            str(permissions.get("canRunReadOnlyChecks", False)).lower(),
            str(permissions.get("canContinueCodeWork", False)).lower(),
            str(permissions.get("canStartSideEffect", False)).lower(),
            str(permissions.get("canRunLiveInput", False)).lower(),
        ))
        for error in report.get("integrityErrors", []):
            print("阻塞：{}".format(error))
    return {"safe_to_resume": 0, "reconciliation_required": 2, "blocked": 3}.get(report.get("decision"), 1)


def render_status(
    state: Dict[str, Any],
    events: List[Dict[str, Any]],
    evidence_records: List[Dict[str, Any]],
) -> str:
    git = state.get("git", {})
    active = state.get("activeSlice") or {}
    checkpoint = state.get("lastCheckpoint") or {}
    checkpoint_id = checkpoint.get("id", "none")
    digest = status_state_digest(state)
    criteria = active.get("acceptanceCriteria", [])
    passed = sum(1 for item in criteria if item.get("status") in {"passed", "not_required"})
    total = len(criteria)
    gates = state.get("projectVerification", {})
    evidence_by_id = {record.get("id"): record for record in evidence_records}
    runtime = state.get("runtime", {})
    resume = state.get("resume", {})
    updated_at = dt.datetime.fromisoformat(str(state.get("updatedAt")).replace("Z", "+00:00"))
    updated_beijing = updated_at.astimezone(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    slice_blockers = active.get("blockers", [])
    freshness = runtime_freshness(state, now=updated_at)
    current_action = state.get("inFlightAction")
    unresolved_action = current_action if current_action and current_action.get("status") in {"running", "unknown_after_interruption"} else None
    effective_next_action = (
        "对账未决副作用动作 {}；结果明确前禁止重放".format(unresolved_action.get("actionId"))
        if unresolved_action
        else active.get("nextAction", "none")
    )
    currently_applicable = []
    for record in evidence_records:
        applicability, reason = evidence_applicability(record, state)
        if applicability == "valid":
            currently_applicable.append((record, reason))
    if currently_applicable:
        trusted_record = currently_applicable[-1][0]
        recent_completion = "{}（{}，当前工作区绑定有效）".format(trusted_record.get("claim"), trusted_record.get("id"))
    elif events:
        recent_completion = "最近事件：{}（{}；不是当前验收通过证据）".format(events[-1].get("summary"), events[-1].get("id"))
    else:
        recent_completion = "none"
    freshness_label = {
        "fresh": "新鲜",
        "stale": "已过期",
        "invalid": "时间无效",
    }.get(freshness.get("status"), str(freshness.get("status")))
    if unresolved_action:
        resume_gate = "STOP：存在未决副作用，只允许只读对账"
    elif not checkpoint.get("safeToResume", False):
        resume_gate = "STOP：最新 checkpoint 未声明可恢复"
    else:
        resume_gate = "可恢复代码工作；其它副作用仍需各自门禁"
    allowed_summary = "只读审计、连续性元数据对账"
    if checkpoint.get("safeToResume", False) and not unresolved_action:
        allowed_summary += "、当前切片内的代码工作"
    prohibited = ["归属不明对象的清理或停止", "未登记 intent 的副作用动作"]
    if unresolved_action:
        prohibited.append("重放未决动作")
    if not checkpoint.get("safeToRunLiveInput", False) or freshness.get("status") != "fresh":
        prohibited.append("真实游戏输入")

    lines: List[str] = [
        "<!-- generated-by: scripts/execution_progress.py; do-not-edit-manually -->",
        "<!-- state-digest: {} -->".format(digest),
        "<!-- checkpoint-id: {} -->".format(checkpoint_id),
        "# 长任务执行状态",
        "",
        "> 本页由 `scripts/execution_progress.py` 从 `state.json`、事件账本和证据账本生成。",
        "> 线程聊天不是恢复权威；冲突时以当前源码、Git、测试和实际运行结果为准。",
        "",
        "## 恢复首屏",
        "",
        "- 恢复结论：**{}**".format(resume_gate),
        "- 更新时间（UTC）：`{}`".format(state.get("updatedAt")),
        "- 更新时间（北京时间）：`{}`".format(updated_beijing),
        "- 长期任务：`{}`".format(state.get("taskId")),
        "- 运行：`{}` / attempt `{}`".format(state.get("run", {}).get("runId"), state.get("run", {}).get("attempt")),
        "- 总体状态：`{}`".format(state.get("overallStatus")),
        "- 当前阶段：`{}`".format(state.get("currentPhaseId")),
        "- 当前切片：`{}` - {}".format(active.get("id"), active.get("title")),
        "- 阶段状态：`{}`；切片状态：`{}`；动作状态：`{}`".format(state.get("phaseStatus"), active.get("status"), state.get("actionStatus")),
        "- 当前切片验收：已满足 `{}`，待验证或阻塞 `{}`，合计 `{}`".format(passed, total - passed, total),
        "- 本轮是否发送真实游戏输入：`{}`".format(str(state.get("safety", {}).get("realInputSent", False)).lower()),
        "- 当前工作：{}".format(
            "未决动作 `{}` 处于 `{}`，等待只读对账".format(unresolved_action.get("actionId"), unresolved_action.get("status"))
            if unresolved_action
            else "当前没有副作用动作在执行，停在下一动作之前"
        ),
        "- 最新当前有效证据：{}".format(recent_completion),
        "- 唯一下一动作：{}".format(effective_next_action),
        "- 当前切片执行 blocker：{}".format("；".join(slice_blockers) if slice_blockers else "none"),
        "- 全局恢复/验收风险：{}".format((resume.get("blockers") or ["none"])[0]),
        "- 最新 checkpoint：`{}`；safeToResume=`{}`；safeToRunLiveInput=`{}`".format(checkpoint_id, str(checkpoint.get("safeToResume", False)).lower(), str(checkpoint.get("safeToRunLiveInput", False)).lower()),
        "- 当前允许：{}。".format(allowed_summary),
        "- 当前禁止：{}。".format("、".join(prohibited)),
        "- 运行观察（STATUS 生成时）：**{}**；observedAt=`{}`；年龄=`{}s`；TTL=`{}s`；expiresAt=`{}`。执行窗口/进程动作前以 `execution:resume-check` 的动态结果为准。".format(freshness_label, freshness.get("observedAt"), freshness.get("ageSeconds"), freshness.get("staleAfterSeconds"), freshness.get("expiresAt")),
        "",
        "## 验收轴",
        "",
        "| 验收轴 | 状态 | 依据/限制 |",
        "|---|---|---|",
    ]
    gate_order = [
        ("codeSurface", "代码表面能力"),
        ("automated", "自动测试"),
        ("currentCommitBuilt", "当前提交构建"),
        ("currentCommitAppLaunched", "当前提交应用已启动"),
        ("hwndInputActuallySent", "后台 HWND 输入已实际发送"),
        ("gamePostconditionObserved", "游戏后置状态已观察"),
        ("foregroundUnaffected", "前台鼠标键盘未受影响"),
        ("secondWindowIsolationVerified", "双窗口隔离"),
        ("restartPersistenceVerified", "重启持久化"),
    ]
    for key, label in gate_order:
        value = gates.get(key, {"status": "pending", "note": ""})
        display_value = value
        display_note = value.get("note", "")
        if value.get("status") in {"passed", "partial"} and value.get("evidenceIds"):
            valid_gate_evidence = [
                evidence_id for evidence_id in value.get("evidenceIds", [])
                if evidence_satisfies_gate(key, evidence_by_id.get(evidence_id, {}), state)
            ]
            if not valid_gate_evidence:
                display_value = {"status": "stale"}
                display_note = "{}；当前没有绑定现有 HEAD/工作树指纹的有效通过证据".format(display_note)
        lines.append("| {} | `{}` | {} |".format(md_cell(label), md_cell(format_gate(display_value)), md_cell(display_note)))

    lines.extend(["", "## 阶段表", "", "| 阶段 | 状态 | 验收摘要 |", "|---|---|---|"])
    for phase in state.get("phases", []):
        lines.append("| `{}` {} | `{}` | {} |".format(md_cell(phase.get("id")), md_cell(phase.get("title")), md_cell(phase.get("status")), md_cell(phase.get("summary", ""))))

    lines.extend(["", "## 当前切片", "", "### 范围", ""])
    lines.append(markdown_list(active.get("scope", []), "尚未开始修改产品代码").rstrip())
    lines.extend(["", "### 非目标", "", markdown_list(active.get("nonGoals", [])).rstrip(), "", "### 安全边界", "", markdown_list(active.get("safetyBoundaries", [])).rstrip(), "", "### 验收条件", ""])
    if criteria:
        lines.extend(["| ID | 条件 | 状态 | 允许证据类别 | 证据 |", "|---|---|---|---|---|"])
        for item in criteria:
            evidence_text = ", ".join("`{}`".format(value) for value in item.get("evidenceIds", [])) or "none"
            category_text = ", ".join("`{}`".format(value) for value in item.get("requiredEvidenceCategories", [])) or "未设定"
            lines.append("| `{}` | {} | `{}` | {} | {} |".format(md_cell(item.get("id")), md_cell(item.get("text")), md_cell(item.get("status")), category_text, evidence_text))
    else:
        lines.append("- none")

    lines.extend(["", "## 当前动作", ""])
    if current_action:
        lines.extend([
            "- actionId：`{}`".format(current_action.get("actionId")),
            "- 类型：`{}`".format(current_action.get("kind")),
            "- 目标：`{}`".format(current_action.get("targetIdentity")),
            "- 副作用级别：`{}`".format(current_action.get("sideEffectClass")),
            "- 状态：`{}`".format(current_action.get("status")),
        ])
    else:
        lines.append("- 当前没有未决副作用动作。")

    lines.extend(["", "## 下一步", "", "- 唯一下一动作：{}".format(effective_next_action)])
    for command in resume.get("nextCommands", []):
        lines.append("- 命令：`{}`".format(command))

    lines.extend(["", "## 阻塞与风险", "", "### 阻塞", "", markdown_list(resume.get("blockers", [])).rstrip(), "", "### 禁止盲目执行", "", markdown_list(resume.get("doNotDo", [])).rstrip()])

    lines.extend([
        "",
        "## Git 现场",
        "",
        "- 分支：`{}`".format(git.get("branch")),
        "- observed HEAD：`{}`".format(git.get("observedHead")),
        "- verified HEAD：`{}`".format(git.get("verifiedHead")),
        "- origin/main：`{}`".format(git.get("upstreamHead")),
        "- working tree fingerprint：`{}`".format(git.get("workingTreeFingerprint")),
        "- 最新 checkpoint：`{}` ({})".format(checkpoint_id, checkpoint.get("type", "none")),
        "- checkpoint safeToResume：`{}`".format(str(checkpoint.get("safeToResume", False)).lower()),
        "- checkpoint safeToRunLiveInput：`{}`".format(str(checkpoint.get("safeToRunLiveInput", False)).lower()),
        "",
        "### 当前非 ignored 改动",
        "",
        markdown_list(["`{}`".format(path) for path in git.get("dirtyPaths", [])]).rstrip(),
    ])

    lines.extend(["", "## 运行进程与产物", "", "### 本轮管理的进程", ""])
    managed_processes = runtime.get("managedProcesses", [])
    if managed_processes:
        for process in managed_processes:
            lines.append("- PID `{}`：{}；cleanupAllowed=`{}`".format(process.get("pid"), process.get("role"), str(process.get("cleanupAllowed", False)).lower()))
    else:
        lines.append("- none")
    lines.extend(["", "### 只观察到的外部进程", ""])
    for process in runtime.get("observedExternalProcesses", []):
        lines.append("- PID `{}`：`{}`，{}；present=`{}`，归属=`{}`，cleanupAllowed=`{}`".format(process.get("pid"), process.get("name"), process.get("role"), str(process.get("present", True)).lower(), process.get("ownership"), str(process.get("cleanupAllowed", False)).lower()))
    lines.extend(["", "### 本轮管理的产物", "", markdown_list(["`{}`".format(item.get("path")) for item in runtime.get("managedArtifacts", [])]).rstrip(), "", "### 观察到但未接管的产物", "", markdown_list(["`{}`".format(item.get("path")) for item in runtime.get("observedArtifacts", [])]).rstrip()])

    lines.extend(["", "## 最近证据", ""])
    if evidence_records:
        lines.extend(["| ID | 类型 | 原始结果 | 当前适用性 | 结论/原因 |", "|---|---|---|---|---|"])
        for record in evidence_records[-8:]:
            applicability, reason = evidence_applicability(record, state)
            lines.append("| `{}` | `{}` | `{}` | `{}` | {}<br>{} |".format(
                md_cell(record.get("id")),
                md_cell(record.get("category")),
                md_cell(record.get("status")),
                md_cell(applicability),
                md_cell(record.get("claim")),
                md_cell(reason),
            ))
    else:
        lines.append("- none")

    lines.extend(["", "## 最近事件", ""])
    if events:
        lines.extend(["| seq | 时间 | 类型 | 摘要 |", "|---:|---|---|---|"])
        for event in events[-10:]:
            lines.append("| {} | `{}` | `{}` | {} |".format(event.get("seq"), md_cell(event.get("timestamp")), md_cell(event.get("eventType")), md_cell(event.get("summary"))))
    else:
        lines.append("- none")

    lines.extend([
        "",
        "## 异常恢复",
        "",
        "1. 阅读 `AGENTS.md`、本页和 `docs/execution/PROTOCOL.md`。",
        "2. 运行 `npm run execution:resume-check`；退出码非 0 时不要执行任何副作用动作。",
        "3. 再运行 `npm run audit:execution-state` 和 `git status --short --ignored`，比较 observed/verified/upstream HEAD 和 dirty 文件。",
        "4. 重新核验 AppData、应用版本、进程、窗口身份和证据文件；过期 PID 只能作为线索。",
        "5. 若存在 `running` 或 `unknown_after_interruption` 动作，先 reconciliation，禁止直接重试。",
        "6. 追加 `reconciliation` 事件后，从“唯一下一动作”继续。",
        "",
        "详细规则见 [PROTOCOL.md](PROTOCOL.md)，长期产品方案见 [project-audit-and-master-plan.md](../project-audit-and-master-plan.md)。",
        "",
    ])
    return "\n".join(lines)


def parse_key_value(value: str, separator: str = "=") -> Tuple[str, str]:
    if separator not in value:
        raise argparse.ArgumentTypeError("expected KEY{}VALUE".format(separator))
    key, text = value.split(separator, 1)
    if not key.strip() or not text.strip():
        raise argparse.ArgumentTypeError("expected non-empty KEY{}VALUE".format(separator))
    return key.strip(), text.strip()


def ledger_action_history() -> Tuple[set, List[Dict[str, Any]]]:
    action_ids = set()
    results: List[Dict[str, Any]] = []
    for event in load_jsonl(EVENTS_PATH):
        details = event.get("details") or {}
        if event.get("eventType") == "action_intent" and details.get("actionId"):
            action_ids.add(details.get("actionId"))
        if event.get("eventType") == "action_result":
            results.append(details)
    return action_ids, results


def load_last_checkpoint(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = state.get("lastCheckpoint")
    if not metadata:
        return None
    path = ROOT / metadata.get("path", "")
    if not path.exists():
        raise RuntimeError("last checkpoint file is missing")
    checkpoint = load_json(path)
    if checkpoint.get("id") != metadata.get("id"):
        raise RuntimeError("last checkpoint id does not match state")
    if checkpoint.get("hash") != metadata.get("hash") or checkpoint.get("hash") != object_hash(checkpoint):
        raise RuntimeError("last checkpoint hash is missing or invalid")
    return checkpoint


def dirty_file_hashes(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for display_path in snapshot.get("dirtyPaths", []):
        candidate_text = display_path.split(" -> ", 1)[-1]
        candidate = ROOT / candidate_text
        item: Dict[str, Any] = {"path": display_path, "exists": candidate.exists()}
        if candidate.is_file():
            item.update({"sha256": file_sha256(candidate), "size": candidate.stat().st_size})
        results.append(item)
    return results


def next_checkpoint_number(state: Dict[str, Any]) -> int:
    highest = int(state.get("checkpointCounter", 0))
    if CHECKPOINT_DIR.exists():
        for path in CHECKPOINT_DIR.glob("CP-*.json"):
            match = re.match(r"CP-(\d{4})-", path.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return highest + 1


def evidence_satisfies_gate(gate_name: str, record: Dict[str, Any], state: Dict[str, Any]) -> bool:
    if record.get("status") != "passed":
        return False
    if not evidence_provenance_valid(record):
        return False
    # Project gates prove the current commit/worktree. verifiedHead advances after
    # build+app-launch gates pass, and remains required for live input.
    if record.get("git", {}).get("observedHead") != state.get("git", {}).get("observedHead"):
        return False
    if record.get("git", {}).get("workingTreeFingerprint") != state.get("git", {}).get("workingTreeFingerprint"):
        return False
    category = record.get("category")
    safety = record.get("safety", {})
    outcome = record.get("outcome", {})
    requirements = {
        "codeSurface": {"source_audit", "test"},
        "automated": {"test"},
        "currentCommitBuilt": {"build"},
        "currentCommitAppLaunched": {"app_runtime"},
        "hwndInputActuallySent": {"live_input", "live_outcome"},
        "gamePostconditionObserved": {"live_outcome"},
        "foregroundUnaffected": {"live_input", "live_outcome"},
        "secondWindowIsolationVerified": {"multi_window"},
        "restartPersistenceVerified": {"persistence"},
    }
    if category not in requirements.get(gate_name, set()):
        return False
    if gate_name in {"hwndInputActuallySent", "gamePostconditionObserved", "foregroundUnaffected"}:
        if not safety.get("inputSent") or not safety.get("windowIdentityVerified"):
            return False
    if gate_name == "gamePostconditionObserved" and not outcome.get("postconditionObserved"):
        return False
    if gate_name == "foregroundUnaffected" and not (safety.get("foregroundUnchanged") and safety.get("cursorUnchanged")):
        return False
    return True


def evidence_satisfies_criterion(criterion: Dict[str, Any], record: Dict[str, Any], state: Dict[str, Any]) -> bool:
    if record.get("status") != "passed":
        return False
    if not evidence_provenance_valid(record):
        return False
    if criterion.get("id") not in record.get("criterionIds", []):
        return False
    required_categories = set(criterion.get("requiredEvidenceCategories", []))
    if not required_categories or record.get("category") not in required_categories:
        return False
    git = record.get("git", {})
    if git.get("observedHead") != state.get("git", {}).get("observedHead"):
        return False
    if record.get("category") != "appdata_backup" and git.get("workingTreeFingerprint") != state.get("git", {}).get("workingTreeFingerprint"):
        return False
    return True


def evidence_provenance_valid(record: Dict[str, Any]) -> bool:
    provenance = record.get("provenance") or {}
    category = record.get("category")
    if category in PROFILE_EVIDENCE_CATEGORIES:
        profile = provenance.get("runnerProfile")
        return provenance.get("captureMethod") == "profile_runner" and PROFILE_CATEGORY_BY_NAME.get(profile) == category
    if category in SPECIALIZED_EVIDENCE_CATEGORIES:
        verifier = provenance.get("verifier")
        return provenance.get("captureMethod") == "specialized_verifier" and verifier in SPECIALIZED_VERIFIER_ALLOWLIST.get(category, set())
    return record.get("status") != "passed"


def command_render(_: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        persist_transaction(state)
    print(STATUS_PATH)


def command_note(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        if getattr(args, "next_action", None):
            state.setdefault("activeSlice", {})["nextAction"] = args.next_action
        if getattr(args, "next_command", None) is not None:
            state.setdefault("resume", {})["nextCommands"] = args.next_command
        if getattr(args, "blocker", None) is not None:
            state.setdefault("resume", {})["blockers"] = args.blocker
        if getattr(args, "do_not", None) is not None:
            state.setdefault("resume", {})["doNotDo"] = args.do_not
        event = create_event(state, args.type, args.summary, {"note": args.detail or ""})
        persist_transaction(state, event=event)
    print(event["id"])


def command_begin_slice(args: argparse.Namespace) -> None:
    criteria = []
    for raw in args.criterion or []:
        left, text = parse_key_value(raw)
        if "|" not in left:
            raise RuntimeError("criterion must use ID|category[,category]=text")
        criterion_id, category_text = left.split("|", 1)
        categories = sorted(set(item.strip() for item in category_text.split(",") if item.strip()))
        if not categories or any(category not in EVIDENCE_CATEGORIES for category in categories):
            raise RuntimeError("criterion contains unknown or empty evidence categories")
        criteria.append({"id": criterion_id, "text": text, "status": "pending", "evidenceIds": [], "requiredEvidenceCategories": categories})
    if not criteria:
        raise RuntimeError("a slice requires at least one acceptance criterion")
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        if state.get("inFlightAction"):
            raise RuntimeError("cannot begin a slice while an action is in flight")
        previous_slice = state.get("activeSlice") or {}
        previous_phase_id = state.get("currentPhaseId")
        if previous_slice.get("id") and previous_slice.get("id") != args.slice:
            if previous_slice.get("status") != "verified":
                raise RuntimeError("cannot replace an active slice before it is verified")
            completed = state.setdefault("completedSlices", [])
            if not any(item.get("id") == previous_slice.get("id") for item in completed):
                archived = json.loads(json.dumps(previous_slice))
                archived["phaseId"] = previous_phase_id
                archived["verifiedAt"] = utc_now()
                completed.append(archived)
        if previous_phase_id and previous_phase_id != args.phase:
            previous_phase = next((item for item in state.get("phases", []) if item.get("id") == previous_phase_id), None)
            if previous_phase and previous_phase.get("status") != "verified":
                raise RuntimeError("cannot enter a new phase before the previous phase is verified")
        state["currentPhaseId"] = args.phase
        state["phaseStatus"] = "in_progress"
        state["actionStatus"] = "none"
        for phase in state.get("phases", []):
            if phase.get("id") == args.phase:
                phase["status"] = "in_progress"
        state["activeSlice"] = {
            "id": args.slice,
            "title": args.title,
            "status": "in_progress",
            "startedAt": utc_now(),
            "scope": args.scope or [],
            "nonGoals": args.non_goal or [],
            "safetyBoundaries": args.safety_boundary or [],
            "acceptanceCriteria": criteria,
            "nextAction": args.next_action,
        }
        event = create_event(state, "slice_started", "开始切片 {}：{}".format(args.slice, args.title))
        persist_transaction(state, event=event)
    print(event["id"])


def command_action_start(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        if not ACTION_ID_PATTERN.fullmatch(args.action_id):
            raise RuntimeError("actionId must match {}".format(ACTION_ID_PATTERN.pattern))
        if args.kind not in ACTION_KINDS:
            raise RuntimeError("unsupported action kind; use an explicit audited kind")
        if args.side_effect_class not in SIDE_EFFECT_CLASSES:
            raise RuntimeError("unsupported side-effect class; unknown classes fail closed")
        if ACTION_CLASS_BY_KIND.get(args.kind) != args.side_effect_class:
            raise RuntimeError("action kind and side-effect class do not match the audited mapping")
        if state.get("inFlightAction"):
            raise RuntimeError("another action is already in flight")
        if state.get("actionStatus") == "unknown_after_interruption":
            raise RuntimeError("an interrupted action is unresolved; reconcile it before starting another action")
        action_ids, action_results = ledger_action_history()
        if args.action_id in action_ids:
            raise RuntimeError("actionId already exists in the append-only ledger")
        for result in action_results:
            if result.get("idempotencyKey") == args.idempotency_key and result.get("status") in {"succeeded", "unknown_after_interruption"}:
                raise RuntimeError("idempotencyKey already has a succeeded or unresolved result")
        if args.side_effect_class in {"process_stop", "local_file_delete"}:
            managed = state.get("runtime", {}).get("managedProcesses", []) if args.side_effect_class == "process_stop" else state.get("runtime", {}).get("managedArtifacts", [])
            matching = []
            for item in managed:
                identity = str(item.get("pid")) if args.side_effect_class == "process_stop" else str(item.get("path"))
                if identity == args.target and item.get("cleanupAllowed") and item.get("createdByRunId") == state.get("run", {}).get("runId") and len(item.get("ownershipEvidence", [])) >= 2:
                    matching.append(item)
            if not matching:
                raise RuntimeError("destructive action target is not a managed object with cleanup permission and ownership evidence")
        if args.side_effect_class == "game_input":
            checkpoint = load_last_checkpoint(state)
            if not checkpoint or not checkpoint.get("safeToRunLiveInput"):
                raise RuntimeError("live input requires the latest checkpoint to be explicitly safeToRunLiveInput")
            current_snapshot = current_git_snapshot()
            if current_snapshot.get("observedHead") != state.get("git", {}).get("verifiedHead"):
                raise RuntimeError("live input requires current HEAD to equal verifiedHead")
            if current_snapshot.get("workingTreeFingerprint") != checkpoint.get("git", {}).get("workingTreeFingerprint"):
                raise RuntimeError("live input requires the current Git snapshot to match the pre-live checkpoint")
            non_metadata_dirty = non_metadata_dirty_paths(current_snapshot)
            if non_metadata_dirty:
                raise RuntimeError("live input refuses uncommitted non-metadata changes")
            gates = state.get("projectVerification", {})
            if gates.get("currentCommitBuilt", {}).get("status") != "passed" or gates.get("currentCommitAppLaunched", {}).get("status") != "passed":
                raise RuntimeError("live input requires current commit build and app launch gates to pass")
            window_identity = state.get("runtime", {}).get("lastWindowIdentity") or {}
            if window_identity.get("targetIdentity") != args.target or not window_identity.get("verified"):
                raise RuntimeError("live input target must match the latest verified window identity observation")
            live_scope = checkpoint.get("liveScope") or {}
            if live_scope.get("targetIdentity") != args.target or live_scope.get("windowEvidenceId") != window_identity.get("evidenceId"):
                raise RuntimeError("live input target/window evidence must match the pre-live checkpoint scope")
            if live_scope.get("privilege") not in {"same", "elevated"} or window_identity.get("identity", {}).get("privilege") not in {"same", "elevated"}:
                raise RuntimeError("live input requires sufficient privilege in both checkpoint and current identity")
            observed_at = dt.datetime.fromisoformat(str(window_identity.get("observedAt")).replace("Z", "+00:00"))
            stale_after = int(state.get("runtime", {}).get("staleAfterSeconds", 300))
            if (dt.datetime.now(dt.timezone.utc) - observed_at).total_seconds() > stale_after:
                raise RuntimeError("live input requires a fresh runtime/window observation")
        backup_identity = None
        if args.kind == "appdata_backup":
            raw_source = getattr(args, "source", None)
            raw_destination = getattr(args, "destination", None)
            expected_sha256 = str(getattr(args, "expected_source_sha256", "") or "").upper()
            if not raw_source or not raw_destination or not re.fullmatch(r"[0-9A-F]{64}", expected_sha256):
                raise RuntimeError("appdata_backup requires absolute source/destination paths and expected-source-sha256")
            source_path = Path(raw_source).expanduser()
            destination_path = Path(raw_destination).expanduser()
            if not source_path.is_absolute() or not destination_path.is_absolute():
                raise RuntimeError("appdata_backup source and destination must be absolute")
            if source_path.is_symlink() or not source_path.is_file():
                raise RuntimeError("appdata_backup source must be an existing non-symlink file")
            source_path = source_path.resolve(strict=True)
            destination_path = destination_path.resolve(strict=False)
            if destination_path.exists() or destination_path.is_symlink():
                raise RuntimeError("appdata_backup destination must not exist at intent time")
            if destination_path == source_path:
                raise RuntimeError("appdata_backup destination must differ from source")
            try:
                destination_path.relative_to(source_path.parent)
            except ValueError:
                raise RuntimeError("appdata_backup destination must remain within the source AppData directory")
            source_sha256 = file_sha256(source_path).upper()
            if source_sha256 != expected_sha256:
                raise RuntimeError("appdata_backup source hash differs from the authorized preflight identity")
            expected_target = "{} -> {}".format(source_path, destination_path)
            if args.target != expected_target:
                raise RuntimeError("appdata_backup target must exactly match the structured source and destination")
            source_stat = source_path.stat()
            backup_identity = {
                "source": {
                    "path": str(source_path),
                    "sha256": source_sha256,
                    "size": source_stat.st_size,
                    "modifiedAtNs": source_stat.st_mtime_ns,
                },
                "destination": {
                    "path": str(destination_path),
                    "existedAtIntent": False,
                },
            }
        action = {
            "actionId": args.action_id,
            "kind": args.kind,
            "targetIdentity": args.target,
            "sideEffectClass": args.side_effect_class,
            "expectedPrecondition": args.precondition,
            "expectedPostcondition": args.postcondition,
            "idempotencyKey": args.idempotency_key,
            "startedAt": utc_now(),
            "ownerRunId": state.get("run", {}).get("runId"),
            "ownershipEvidence": args.ownership_evidence or [],
            "status": "running",
        }
        if backup_identity:
            action["backupIdentity"] = backup_identity
        if args.kind in MACHINE_LEASE_ACTION_KINDS:
            lease_token = create_action_token(args.action_id)
            action["leaseTokenHash"] = hashlib.sha256(lease_token.encode("utf-8")).hexdigest()
            try:
                create_external_action_lease(action, state, lease_token)
            except Exception:
                delete_action_token(args.action_id)
                raise
        state["inFlightAction"] = action
        state["actionStatus"] = "running"
        event = create_event(state, "action_intent", "登记副作用动作 {}".format(args.action_id), public_action(action))
        persist_transaction(state, event=event)
    print(event["id"])


def command_action_finish(args: argparse.Namespace) -> None:
    if args.status not in {"succeeded", "failed", "unknown_after_interruption"}:
        raise ValueError("invalid action result status")
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        action = state.get("inFlightAction")
        if not action or action.get("actionId") != args.action_id:
            raise RuntimeError("matching in-flight action not found")
        if action.get("status") == "unknown_after_interruption" and args.status != "unknown_after_interruption":
            raise RuntimeError("unknown_after_interruption cannot be resolved by free-form action-finish; use specialized reconciliation evidence")
        verified_evidence_id = getattr(args, "verified_evidence_id", None)
        if action.get("kind") == "appdata_backup" and args.status == "succeeded":
            evidence_record = next(
                (record for record in load_jsonl(EVIDENCE_PATH) if record.get("id") == verified_evidence_id),
                None,
            )
            verification = (evidence_record or {}).get("verification") or {}
            if (
                not evidence_record
                or evidence_record.get("category") != "appdata_backup"
                or evidence_record.get("status") != "passed"
                or not evidence_provenance_valid(evidence_record)
                or verification.get("actionId") != args.action_id
            ):
                raise RuntimeError("appdata_backup can succeed only with matching allowlisted verifier evidence")
        lease_token = None
        if action.get("kind") in MACHINE_LEASE_ACTION_KINDS:
            lease_token = load_action_token(args.action_id)
            verify_external_action_lease(args.action_id, lease_token)
        result = dict(action)
        result.update({"status": args.status, "endedAt": utc_now(), "result": args.result})
        if verified_evidence_id:
            result["verifiedEvidenceId"] = verified_evidence_id
        if args.status == "succeeded" and action.get("kind") == "process_stop":
            runtime = state.setdefault("runtime", {})
            target_pid = str(action.get("targetIdentity") or "")
            managed = [
                item for item in runtime.get("managedProcesses", [])
                if str(item.get("pid")) != target_pid
            ]
            runtime["managedProcesses"] = managed
            observed = []
            for item in runtime.get("observedExternalProcesses", []):
                if str(item.get("pid")) == target_pid:
                    item = dict(item)
                    item["present"] = False
                    item["observedAbsentAt"] = utc_now()
                    item["lastObservedAt"] = utc_now()
                    item["cleanupAllowed"] = False
                observed.append(item)
            runtime["observedExternalProcesses"] = observed
            runtime["observedAt"] = utc_now()
        state["lastAction"] = result
        state["actionStatus"] = args.status
        state["inFlightAction"] = result if args.status == "unknown_after_interruption" else None
        event = create_event(state, "action_result", "副作用动作 {} -> {}".format(args.action_id, args.status), public_action(result))
        persist_transaction(state, event=event)
        if args.status != "unknown_after_interruption" and action.get("kind") in MACHINE_LEASE_ACTION_KINDS:
            release_external_action_lease(args.action_id, lease_token)
            delete_action_token(args.action_id)
    print(event["id"])


def validate_expected_criterion_binding(
    state: Dict[str, Any],
    expected_binding: Any,
    category: str,
    criterion_ids: List[str],
) -> None:
    if expected_binding is None:
        return
    if not isinstance(expected_binding, dict):
        raise RuntimeError("expected_criterion_binding must be an object")
    expected_slice_id = expected_binding.get("sliceId")
    expected_criterion_id = expected_binding.get("criterionId")
    expected_categories = expected_binding.get("requiredEvidenceCategories")
    if (
        not isinstance(expected_slice_id, str)
        or not expected_slice_id
        or not isinstance(expected_criterion_id, str)
        or not expected_criterion_id
        or not isinstance(expected_categories, list)
        or not all(isinstance(item, str) for item in expected_categories)
    ):
        raise RuntimeError("expected_criterion_binding is incomplete")
    active_slice = state.get("activeSlice") or {}
    if active_slice.get("id") != expected_slice_id:
        raise RuntimeError("active slice changed after the verifier observation")
    active_criteria = {
        item.get("id"): item for item in active_slice.get("acceptanceCriteria", [])
    }
    criterion = active_criteria.get(expected_criterion_id)
    actual_categories = criterion.get("requiredEvidenceCategories", []) if criterion else []
    if not isinstance(actual_categories, list) or sorted(actual_categories) != sorted(expected_categories):
        raise RuntimeError("active criterion policy changed after the verifier observation")
    if category not in actual_categories:
        raise RuntimeError("evidence category is no longer allowed by the active criterion")
    if list(criterion_ids) != [expected_criterion_id]:
        raise RuntimeError("verifier evidence criterion no longer matches its active binding")


def record_evidence(args: argparse.Namespace, allow_passed: bool = False) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        expected_git_binding = getattr(args, "expected_git_binding", None)
        if expected_git_binding is not None:
            if not isinstance(expected_git_binding, dict):
                raise RuntimeError("expected_git_binding must be an object")
            current_git = state.get("git") or {}
            expected_head = expected_git_binding.get("observedHead")
            expected_fingerprint = expected_git_binding.get("workingTreeFingerprint")
            if not expected_head or not expected_fingerprint:
                raise RuntimeError("expected_git_binding lacks observedHead or workingTreeFingerprint")
            if (
                current_git.get("observedHead") != expected_head
                or current_git.get("workingTreeFingerprint") != expected_fingerprint
            ):
                raise RuntimeError("source workspace changed after the verifier observation")
        if args.category not in EVIDENCE_CATEGORIES:
            raise RuntimeError("unknown evidence category")
        validate_expected_criterion_binding(
            state,
            getattr(args, "expected_criterion_binding", None),
            args.category,
            args.criterion or [],
        )
        capture_method = getattr(args, "capture_method", "manual")
        runner_profile = getattr(args, "runner_profile", None)
        verifier = getattr(args, "verifier", None)
        if args.status == "passed":
            if not allow_passed:
                raise RuntimeError("passed evidence can only be emitted by run-evidence or an allowlisted specialized verifier")
            if args.category in PROFILE_EVIDENCE_CATEGORIES and capture_method != "profile_runner":
                raise RuntimeError("passed static/test/build evidence must come from run-evidence profile execution")
            if args.category in SPECIALIZED_EVIDENCE_CATEGORIES and capture_method != "specialized_verifier":
                raise RuntimeError("passed runtime/live/persistence/backup evidence requires a specialized verifier")
        command_required_categories = {"source_audit", "test", "build", "app_runtime", "live_preflight", "multi_window", "persistence", "appdata_backup", "cleanup_audit"}
        artifact_required_categories = {"build", "app_runtime", "live_preflight", "live_outcome", "multi_window", "persistence", "appdata_backup"}
        if args.status == "passed" and args.category in command_required_categories:
            if not args.command or args.exit_code != 0:
                raise RuntimeError("passed {} evidence requires a command and exitCode 0".format(args.category))
        if args.status == "passed" and args.category in artifact_required_categories and not args.artifact:
            raise RuntimeError("passed {} evidence requires at least one artifact".format(args.category))
        if args.category in {"live_preflight", "live_input", "live_outcome"} and args.status == "passed":
            if not args.window_evidence_id or not args.target_identity:
                raise RuntimeError("passed live evidence requires windowEvidenceId and targetIdentity")
            if args.category == "live_preflight" and args.input_sent is not False:
                raise RuntimeError("passed live_preflight evidence must explicitly report inputSent=false")
            if args.category in {"live_input", "live_outcome"} and not args.input_sent:
                raise RuntimeError("passed live input/outcome evidence requires inputSent")
            existing_evidence = {record.get("id"): record for record in load_jsonl(EVIDENCE_PATH)}
            window_record = existing_evidence.get(args.window_evidence_id)
            window_privilege = (window_record or {}).get("windowIdentity", {}).get("privilege")
            if (
                not window_record
                or window_record.get("category") != "window_identity"
                or window_record.get("targetIdentity") != args.target_identity
                or not window_record.get("safety", {}).get("windowIdentityVerified")
                or not evidence_provenance_valid(window_record)
                or window_privilege not in {"same", "elevated"}
            ):
                raise RuntimeError("windowEvidenceId does not prove the requested target identity")
        if args.category == "live_outcome" and args.status == "passed" and not args.postcondition_observed:
            raise RuntimeError("passed live_outcome evidence requires an observed postcondition")
        if args.category == "window_identity" and args.status in {"passed", "observed"}:
            window_fields = [args.target_identity, args.window_hwnd, args.window_pid, args.window_title, args.window_process, args.client_width, args.client_height, args.privilege]
            if not args.window_identity_verified or any(value in {None, ""} for value in window_fields):
                raise RuntimeError("window_identity evidence requires hwnd, pid, title, process, client size, privilege, and verified targetIdentity")
        if args.category in {"runtime_observation", "app_runtime", "live_preflight", "live_input", "live_outcome"}:
            state.setdefault("runtime", {})["observedAt"] = utc_now()
        records = load_jsonl(EVIDENCE_PATH)
        evidence_id = args.id or "EVD-{:04d}".format(len(records) + 1)
        if any(record.get("id") == evidence_id for record in records):
            raise RuntimeError("evidence id already exists in the append-only ledger")
        artifacts = []
        for raw_path in args.artifact or []:
            path = Path(raw_path)
            absolute = path if path.is_absolute() else ROOT / path
            artifact: Dict[str, Any] = {"path": raw_path, "exists": absolute.exists()}
            if absolute.is_file():
                artifact.update({"sha256": file_sha256(absolute), "size": absolute.stat().st_size})
            if args.status == "passed" and not artifact.get("exists"):
                raise RuntimeError("passed evidence cannot reference a missing artifact: {}".format(raw_path))
            artifacts.append(artifact)
        run_id, attempt = current_session(state)
        active = state.get("activeSlice") or {}
        payload = {
            "capturedAt": utc_now(),
            "runId": run_id,
            "attempt": attempt,
            "phaseId": state.get("currentPhaseId"),
            "sliceId": active.get("id"),
            "criterionIds": args.criterion or [],
            "category": args.category,
            "claim": args.claim,
            "targetIdentity": args.target_identity,
            "windowEvidenceId": args.window_evidence_id,
            "status": args.status,
            "command": args.command,
            "exitCode": args.exit_code,
            "git": {
                "observedHead": state.get("git", {}).get("observedHead"),
                "verifiedHead": state.get("git", {}).get("verifiedHead"),
                "dirtyPaths": state.get("git", {}).get("dirtyPaths", []),
                "workingTreeFingerprint": state.get("git", {}).get("workingTreeFingerprint"),
            },
            "artifacts": artifacts,
            "safety": {
                "inputSent": args.input_sent,
                "foregroundUnchanged": args.foreground_unchanged,
                "cursorUnchanged": args.cursor_unchanged,
                "windowIdentityVerified": args.window_identity_verified,
            },
            "outcome": {
                "postconditionObserved": args.postcondition_observed,
            },
            "verification": getattr(args, "verification", None),
            "provenance": {
                "captureMethod": capture_method,
                "runnerProfile": runner_profile,
                "verifier": verifier,
            },
            "windowIdentity": {
                "hwnd": args.window_hwnd,
                "pid": args.window_pid,
                "title": args.window_title,
                "process": args.window_process,
                "clientWidth": args.client_width,
                "clientHeight": args.client_height,
                "privilege": args.privilege,
            } if args.category == "window_identity" else None,
        }
        if args.status == "passed" and not evidence_provenance_valid(payload):
            raise RuntimeError("passed evidence lacks trusted profile-runner or specialized-verifier provenance")
        if args.input_sent:
            state.setdefault("safety", {})["realInputSent"] = True
        if args.category == "window_identity" and args.window_identity_verified and args.target_identity:
            state.setdefault("runtime", {})["lastWindowIdentity"] = {
                "targetIdentity": args.target_identity,
                "verified": True,
                "observedAt": utc_now(),
                "evidenceId": evidence_id,
                "identity": payload["windowIdentity"],
            }
        evidence = next_ledger_record(EVIDENCE_PATH, "mhxy-shikong.execution-evidence", evidence_id, payload)
        for criterion in active.get("acceptanceCriteria", []):
            if criterion.get("id") in (args.criterion or []):
                if evidence_id not in criterion.setdefault("evidenceIds", []):
                    criterion["evidenceIds"].append(evidence_id)
                if args.status == "passed":
                    required_categories = set(criterion.get("requiredEvidenceCategories", []))
                    if not required_categories:
                        raise RuntimeError("criterion has no evidence category policy")
                    if args.category not in required_categories:
                        raise RuntimeError("evidence category does not satisfy criterion policy")
                    criterion["status"] = "passed"
                elif args.status in {"failed", "blocked"}:
                    criterion["status"] = args.status
        if args.category in {"test", "build"}:
            event_type = "test_run"
        elif args.category in {"runtime_observation", "window_identity", "app_runtime", "live_preflight", "live_input", "live_outcome"}:
            event_type = "runtime_observation"
        else:
            event_type = "evidence_recorded"
        event = create_event(state, event_type, args.claim, evidence_ids=[evidence_id])
        persist_transaction(state, event=event, evidence=evidence)
    print(evidence_id)
    return evidence_id


def command_evidence(args: argparse.Namespace) -> None:
    record_evidence(args, allow_passed=False)


def command_gate(args: argparse.Namespace) -> None:
    if args.status not in GATE_STATUSES:
        raise ValueError("invalid gate status")
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        gates = state.setdefault("projectVerification", {})
        if args.name not in gates:
            raise KeyError("unknown verification gate: {}".format(args.name))
        if args.status == "passed":
            if not args.evidence:
                raise RuntimeError("passed gate requires evidence ids")
            evidence_by_id = {record.get("id"): record for record in load_jsonl(EVIDENCE_PATH)}
            missing = [evidence_id for evidence_id in args.evidence if evidence_id not in evidence_by_id]
            if missing:
                raise RuntimeError("gate references missing evidence: {}".format(", ".join(missing)))
            if not any(evidence_satisfies_gate(args.name, evidence_by_id[evidence_id], state) for evidence_id in args.evidence):
                raise RuntimeError("provided evidence does not satisfy the semantic requirements for this gate")
        gates[args.name] = {"status": args.status, "note": args.note, "evidenceIds": args.evidence or []}
        if args.status == "passed" and args.name in {"currentCommitBuilt", "currentCommitAppLaunched"}:
            built = gates.get("currentCommitBuilt", {})
            launched = gates.get("currentCommitAppLaunched", {})
            if built.get("status") == "passed" and launched.get("status") == "passed":
                evidence_by_id = {record.get("id"): record for record in load_jsonl(EVIDENCE_PATH)}
                built_ok = any(
                    evidence_satisfies_gate("currentCommitBuilt", evidence_by_id.get(eid, {}), state)
                    for eid in built.get("evidenceIds", [])
                )
                launch_ok = any(
                    evidence_satisfies_gate("currentCommitAppLaunched", evidence_by_id.get(eid, {}), state)
                    for eid in launched.get("evidenceIds", [])
                )
                snapshot = current_git_snapshot()
                if (
                    built_ok
                    and launch_ok
                    and not non_metadata_dirty_paths(snapshot)
                    and snapshot.get("observedHead")
                ):
                    state.setdefault("git", {})["verifiedHead"] = snapshot["observedHead"]
                    state.setdefault("git", {})["lastKnownStableCommit"] = snapshot["observedHead"]
        event = create_event(state, "slice_state_changed", "更新验收轴 {} -> {}".format(args.name, args.status), gates[args.name], args.evidence or [])
        persist_transaction(state, event=event)
    print(event["id"])


def command_checkpoint(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        if state.get("inFlightAction"):
            raise RuntimeError("cannot checkpoint while an action is in flight")
        if args.type == "git_checkpoint":
            if state.get("git", {}).get("observedHead") != state.get("git", {}).get("verifiedHead"):
                raise RuntimeError("git_checkpoint requires observedHead to equal verifiedHead")
            non_metadata_dirty = non_metadata_dirty_paths(state.get("git", {}))
            if non_metadata_dirty:
                raise RuntimeError("git_checkpoint cannot include uncommitted non-metadata paths: {}".format(", ".join(non_metadata_dirty)))
        if args.safe_to_run_live_input:
            if "pre-live" not in args.label.lower():
                raise RuntimeError("safeToRunLiveInput checkpoint label must contain pre-live")
            gates = state.get("projectVerification", {})
            if gates.get("currentCommitBuilt", {}).get("status") != "passed" or gates.get("currentCommitAppLaunched", {}).get("status") != "passed":
                raise RuntimeError("safeToRunLiveInput requires build and current app launch gates to pass")
            evidence_by_id = {record.get("id"): record for record in load_jsonl(EVIDENCE_PATH)}
            for gate_name in ("currentCommitBuilt", "currentCommitAppLaunched"):
                gate_evidence_ids = gates.get(gate_name, {}).get("evidenceIds", [])
                if not any(evidence_satisfies_gate(gate_name, evidence_by_id.get(evidence_id, {}), state) for evidence_id in gate_evidence_ids):
                    raise RuntimeError("safeToRunLiveInput requires current valid evidence for {}".format(gate_name))
            if state.get("git", {}).get("observedHead") != state.get("git", {}).get("verifiedHead"):
                raise RuntimeError("safeToRunLiveInput requires observedHead to equal verifiedHead")
            non_metadata_dirty = non_metadata_dirty_paths(state.get("git", {}))
            if non_metadata_dirty:
                raise RuntimeError("safeToRunLiveInput requires no uncommitted non-metadata paths")
            window_identity = state.get("runtime", {}).get("lastWindowIdentity") or {}
            if not window_identity.get("verified"):
                raise RuntimeError("safeToRunLiveInput requires a verified window identity observation")
            window_record = next((record for record in load_jsonl(EVIDENCE_PATH) if record.get("id") == window_identity.get("evidenceId")), None)
            if not window_record or not evidence_provenance_valid(window_record):
                raise RuntimeError("safeToRunLiveInput requires window identity from a specialized verifier")
            if window_identity.get("identity", {}).get("privilege") not in {"same", "elevated"}:
                raise RuntimeError("safeToRunLiveInput requires sufficient target privilege")
            observed_at = dt.datetime.fromisoformat(str(window_identity.get("observedAt")).replace("Z", "+00:00"))
            if (dt.datetime.now(dt.timezone.utc) - observed_at).total_seconds() > int(state.get("runtime", {}).get("staleAfterSeconds", 300)):
                raise RuntimeError("safeToRunLiveInput requires a fresh window identity observation")
        checkpoint_number = next_checkpoint_number(state)
        checkpoint_id = "CP-{:04d}".format(checkpoint_number)
        label = re.sub(r"[^a-z0-9]+", "-", args.label.lower()).strip("-") or "checkpoint"
        file_name = "{}-{}.json".format(checkpoint_id, label)
        checkpoint_path = CHECKPOINT_DIR / file_name
        snapshot = current_git_snapshot()
        diff_bytes = subprocess.run(
            ["git", "diff", "HEAD", "--binary"],
            cwd=str(ROOT),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout
        checkpoint = {
            "kind": "mhxy-shikong.execution-checkpoint",
            "schemaVersion": 1,
            "id": checkpoint_id,
            "createdAt": utc_now(),
            "type": args.type,
            "reason": args.reason,
            "run": state.get("run"),
            "phaseId": state.get("currentPhaseId"),
            "slice": state.get("activeSlice"),
            "git": snapshot,
            "gitDiffSha256": hashlib.sha256(diff_bytes).hexdigest(),
            "dirtyFileHashes": dirty_file_hashes(snapshot),
            "eventTail": state.get("eventTail"),
            "evidenceTail": state.get("evidenceTail"),
            "inFlightAction": state.get("inFlightAction"),
            "runtime": state.get("runtime"),
            "resume": state.get("resume"),
            "safeToResume": args.safe_to_resume,
            "safeToRunLiveInput": args.safe_to_run_live_input,
            "liveScope": {
                "targetIdentity": state.get("runtime", {}).get("lastWindowIdentity", {}).get("targetIdentity"),
                "windowEvidenceId": state.get("runtime", {}).get("lastWindowIdentity", {}).get("evidenceId"),
                "privilege": state.get("runtime", {}).get("lastWindowIdentity", {}).get("identity", {}).get("privilege"),
            } if args.safe_to_run_live_input else None,
        }
        checkpoint["hash"] = object_hash(checkpoint)
        CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
        with checkpoint_path.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        final_checkpoint_snapshot = current_git_snapshot()
        checkpoint["git"] = final_checkpoint_snapshot
        checkpoint["dirtyFileHashes"] = dirty_file_hashes(final_checkpoint_snapshot)
        checkpoint["hash"] = object_hash(checkpoint)
        atomic_write_json(checkpoint_path, checkpoint)
        state.setdefault("git", {}).update(final_checkpoint_snapshot)
        state["checkpointCounter"] = checkpoint_number
        state["lastCheckpoint"] = {
            "id": checkpoint_id,
            "type": args.type,
            "path": checkpoint_path.relative_to(ROOT).as_posix(),
            "createdAt": checkpoint["createdAt"],
            "safeToResume": args.safe_to_resume,
            "safeToRunLiveInput": args.safe_to_run_live_input,
            "hash": checkpoint["hash"],
        }
        if args.safe_to_resume:
            state.setdefault("resume", {})["lastSafeResumeSnapshotId"] = checkpoint_id
        if args.type == "git_checkpoint":
            state.setdefault("resume", {})["lastVerifiedGitCheckpointId"] = checkpoint_id
        state.setdefault("resume", {}).pop("lastKnownGoodCheckpointId", None)
        event = create_event(state, "checkpoint", "创建 {}：{}".format(checkpoint_id, args.reason), {"path": state["lastCheckpoint"]["path"], "type": args.type})
        persist_transaction(state, event=event)
    print(checkpoint_path)


def command_slice_state(args: argparse.Namespace) -> None:
    slice_statuses = {"ready", "in_progress", "verifying", "verified", "blocked"}
    if args.slice_status not in slice_statuses:
        raise ValueError("invalid slice status")
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        if state.get("inFlightAction"):
            raise RuntimeError("cannot change slice state while an action is unresolved")
        if state.get("actionStatus") == "unknown_after_interruption":
            raise RuntimeError("cannot change slice state while an interrupted action is unresolved")
        if args.slice_status == "verified" or args.phase_status == "verified":
            unfinished = [
                criterion.get("id") for criterion in state.get("activeSlice", {}).get("acceptanceCriteria", [])
                if criterion.get("status") not in {"passed", "not_required"}
            ]
            if unfinished:
                raise RuntimeError("cannot verify slice/phase with unfinished criteria: {}".format(", ".join(unfinished)))
            missing_policies = [criterion.get("id") for criterion in state.get("activeSlice", {}).get("acceptanceCriteria", []) if not criterion.get("requiredEvidenceCategories")]
            if missing_policies:
                raise RuntimeError("cannot verify slice/phase without criterion evidence policies: {}".format(", ".join(missing_policies)))
            evidence_by_id = {record.get("id"): record for record in load_jsonl(EVIDENCE_PATH)}
            invalid_evidence = [
                criterion.get("id") for criterion in state.get("activeSlice", {}).get("acceptanceCriteria", [])
                if not any(evidence_satisfies_criterion(criterion, evidence_by_id.get(evidence_id, {}), state) for evidence_id in criterion.get("evidenceIds", []))
            ]
            if invalid_evidence:
                raise RuntimeError("cannot verify slice/phase with stale or invalid criterion evidence: {}".format(", ".join(invalid_evidence)))
            if args.phase_status == "verified" and args.slice_status != "verified":
                raise RuntimeError("a phase can be verified only when its active slice is verified")
        state["phaseStatus"] = args.phase_status
        active = state.setdefault("activeSlice", {})
        active["status"] = args.slice_status
        if args.next_action:
            active["nextAction"] = args.next_action
        if args.blocker is not None:
            active["blockers"] = args.blocker
        for phase in state.get("phases", []):
            if phase.get("id") == state.get("currentPhaseId"):
                phase["status"] = args.phase_status
        details = {
            "phaseStatus": args.phase_status,
            "sliceStatus": args.slice_status,
            "blockers": active.get("blockers", []),
        }
        event = create_event(state, "slice_state_changed", args.summary, details)
        persist_transaction(state, event=event)
    print(event["id"])


def command_criterion_policy(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        criterion = next((item for item in state.get("activeSlice", {}).get("acceptanceCriteria", []) if item.get("id") == args.criterion), None)
        if not criterion:
            raise RuntimeError("criterion not found in active slice")
        previous_status = criterion.get("status")
        if previous_status not in {"pending", "failed"}:
            raise RuntimeError("criterion policy can only be changed while pending or failed")
        categories = sorted(set(args.category or []))
        if not categories or any(category not in EVIDENCE_CATEGORIES for category in categories):
            raise RuntimeError("criterion policy requires known evidence categories")
        criterion["requiredEvidenceCategories"] = categories
        if previous_status == "failed":
            criterion["status"] = "pending"
        event = create_event(
            state,
            "scope_change",
            "设置 {} 的证据类别门禁".format(args.criterion),
            {
                "criterionId": args.criterion,
                "previousStatus": previous_status,
                "requiredEvidenceCategories": categories,
            },
        )
        persist_transaction(state, event=event)
    print(event["id"])


def command_process_observation(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        if args.present and (not args.name or not args.creation_time):
            raise RuntimeError("present process observation requires name and creation-time to avoid PID reuse ambiguity")
        state = load_json(STATE_PATH)
        refresh_state_runtime_fields(state)
        observed_at = utc_now()
        runtime = state.setdefault("runtime", {})
        runtime["observedAt"] = observed_at
        processes = runtime.setdefault("observedExternalProcesses", [])
        process = next((item for item in processes if int(item.get("pid", -1)) == args.pid), None)
        if process is None:
            process = {
                "pid": args.pid,
                "name": args.name,
                "role": args.role,
                "ownership": args.ownership,
                "cleanupAllowed": False,
            }
            processes.append(process)
        process.update(
            {
                "name": args.name or process.get("name"),
                "role": args.role or process.get("role"),
                "ownership": args.ownership or process.get("ownership"),
                "present": args.present,
                "lastObservedAt": observed_at,
                "cleanupAllowed": False,
            }
        )
        if args.present:
            process["lastSeenAt"] = observed_at
            process["creationTime"] = args.creation_time
        else:
            process["observedAbsentAt"] = observed_at
        if args.identity_limit:
            process["identityLimit"] = args.identity_limit
        event = create_event(
            state,
            "runtime_observation",
            args.summary,
            {"pid": args.pid, "present": args.present, "name": process.get("name")},
        )
        persist_transaction(state, event=event)
    print(event["id"])


def command_reconcile(args: argparse.Namespace) -> None:
    with ProgressLock(progress_lock_path()):
        state = load_json(STATE_PATH)
        events = load_jsonl(EVENTS_PATH)
        evidence = load_jsonl(EVIDENCE_PATH)
        lease = load_external_action_lease()
        if lease:
            leased_action = lease.get("action") or {}
            if state.get("inFlightAction") and state.get("inFlightAction", {}).get("actionId") != leased_action.get("actionId"):
                raise RuntimeError("repository state and machine-level external action lease disagree")
            if not state.get("inFlightAction"):
                resolved = [
                    event.get("details") or {} for event in events
                    if event.get("eventType") == "action_result"
                    and (event.get("details") or {}).get("actionId") == leased_action.get("actionId")
                    and (event.get("details") or {}).get("status") in {"succeeded", "failed"}
                ]
                if resolved:
                    action_id = leased_action.get("actionId")
                    lease_token = load_action_token(action_id)
                    verify_external_action_lease(action_id, lease_token)
                    release_external_action_lease(action_id, lease_token)
                    delete_action_token(action_id)
                    lease = None
                else:
                    leased_action = dict(leased_action)
                    leased_action["status"] = "unknown_after_interruption"
                    leased_action["interruptedAt"] = utc_now()
                    state["inFlightAction"] = leased_action
                    state["lastAction"] = leased_action
                    state["actionStatus"] = "unknown_after_interruption"
        if events:
            update_tail(state, "eventTail", events[-1])
        else:
            state["eventTail"] = {"seq": 0, "id": None, "hash": None}
        if evidence:
            update_tail(state, "evidenceTail", evidence[-1])
        else:
            state["evidenceTail"] = {"seq": 0, "id": None, "hash": None}
        action = state.get("inFlightAction")
        if action and action.get("status") == "running":
            action = dict(action)
            action["status"] = "unknown_after_interruption"
            action["interruptedAt"] = utc_now()
            state["inFlightAction"] = action
            state["lastAction"] = action
            state["actionStatus"] = "unknown_after_interruption"
        if args.increment_attempt:
            state.setdefault("run", {})["attempt"] = int(state.get("run", {}).get("attempt", 1)) + 1
        if args.thread_id:
            state.setdefault("run", {})["primaryThreadId"] = args.thread_id
        if args.next_action:
            state.setdefault("activeSlice", {})["nextAction"] = args.next_action
        refresh_state_runtime_fields(state)
        event = create_event(
            state,
            "reconciliation",
            args.summary,
            {
                "incrementedAttempt": args.increment_attempt,
                "unresolvedActionId": (state.get("inFlightAction") or {}).get("actionId"),
            },
        )
        persist_transaction(state, event=event)
    print(event["id"])


def command_repair_tail(args: argparse.Namespace) -> None:
    if not args.confirm_quarantine_truncated_tail:
        raise RuntimeError("repair-tail requires --confirm-quarantine-truncated-tail")
    ledger_path = EVENTS_PATH if args.ledger == "events" else EVIDENCE_PATH
    ledger_kind = "mhxy-shikong.execution-event" if args.ledger == "events" else "mhxy-shikong.execution-evidence"
    with ProgressLock(progress_lock_path()):
        raw = ledger_path.read_bytes()
        lines = raw.splitlines(keepends=True)
        valid_count = 0
        invalid_fragment = None
        previous_hash = None
        expected_seq = 1
        for index, raw_line in enumerate(lines):
            if not raw_line.strip():
                valid_count = index + 1
                continue
            try:
                record = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                remaining_nonempty = [line for line in lines[index + 1:] if line.strip()]
                if remaining_nonempty or raw.endswith(b"\n") or raw.endswith(b"\r"):
                    raise RuntimeError("automatic repair only accepts a torn final JSON fragment without a line terminator")
                invalid_fragment = raw_line
                break
            if record.get("kind") != ledger_kind or record.get("seq") != expected_seq or record.get("prevHash") != previous_hash or record.get("hash") != object_hash(record):
                raise RuntimeError("complete JSON record has a sequence/hash mismatch; refusing automatic repair")
            previous_hash = record.get("hash")
            expected_seq += 1
            valid_count = index + 1
        if invalid_fragment is None:
            raise RuntimeError("ledger does not have a truncated final record")

        fragment_dir = EXECUTION_DIR / "recovery-fragments"
        fragment_dir.mkdir(parents=True, exist_ok=True)
        stamp = utc_now().replace(":", "").replace("-", "")
        fragment_path = fragment_dir / "{}-{}-truncated-tail.bin".format(stamp, args.ledger)
        with fragment_path.open("xb") as handle:
            handle.write(invalid_fragment)
            handle.flush()
            os.fsync(handle.fileno())
        atomic_write_bytes(ledger_path, b"".join(lines[:valid_count]))

        state = load_json(STATE_PATH)
        repaired_records = load_jsonl(ledger_path)
        tail_key = "eventTail" if args.ledger == "events" else "evidenceTail"
        if repaired_records:
            update_tail(state, tail_key, repaired_records[-1])
        else:
            state[tail_key] = {"seq": 0, "id": None, "hash": None}
        state.setdefault("run", {})["attempt"] = int(state.get("run", {}).get("attempt", 1)) + 1
        state.setdefault("runtime", {}).setdefault("managedArtifacts", []).append(
            {
                "path": fragment_path.relative_to(ROOT).as_posix(),
                "ownership": "created_by_current_run",
                "createdByRunId": state.get("run", {}).get("runId"),
                "ownershipEvidence": ["repair-tail command created this exact path", "path was opened with exclusive create"],
                "cleanupAllowed": False,
            }
        )
        refresh_state_runtime_fields(state)
        event = create_event(
            state,
            "reconciliation",
            args.summary,
            {
                "ledger": args.ledger,
                "quarantinedFragment": fragment_path.relative_to(ROOT).as_posix(),
                "validRecordCount": len(repaired_records),
            },
        )
        persist_transaction(state, event=event)
    print(fragment_path)


def command_run_evidence(args: argparse.Namespace) -> None:
    if args.timeout_seconds < 1 or args.timeout_seconds > 3600:
        raise RuntimeError("timeout-seconds must be between 1 and 3600")
    npm = "npm.cmd" if os.name == "nt" else "npm"
    profiles: Dict[str, Dict[str, Any]] = {
        "node-all": {
            "category": "test",
            "cwd": ROOT,
            "commands": [[npm, "run", "test:all-core"]],
            "artifacts": [],
        },
        "python-audits": {
            "category": "test",
            "cwd": ROOT,
            "commands": [[npm, "run", "audit:all"]],
            "artifacts": [],
        },
        "frontend-build": {
            "category": "build",
            "cwd": ROOT,
            "commands": [[npm, "run", "build"]],
            "artifacts": ["dist/index.html"],
        },
        "rust-static": {
            "category": "test",
            "cwd": ROOT / "src-tauri",
            "commands": [
                ["cargo", "fmt", "--check"],
                ["cargo", "check"],
                ["cargo", "test"],
                ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"],
            ],
            "artifacts": [],
        },
        "p0-preflight": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "preflight_p0_workspace.py"), "--json"]],
            "artifacts": [],
        },
        "save-coordinator-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_save_coordinator.py")]],
            "artifacts": [],
        },
        "asset-store-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_asset_store.py")]],
            "artifacts": [],
        },
        "workspace-persistence-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_workspace_persistence.py")]],
            "artifacts": [],
        },
        "welfare-sign-in-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_welfare_sign_in_offline.py")]],
            "artifacts": [],
        },
        "bag-organize-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_bag_organize_offline.py")]],
            "artifacts": [],
        },
        "home-vitality-offline": {
            "category": "source_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_home_vitality_offline.py")]],
            "artifacts": [],
        },
        "p0-safety-boundary": {
            "category": "cleanup_audit",
            "cwd": ROOT,
            "commands": [[sys.executable, str(ROOT / "scripts" / "audit_p0_safety_boundary.py"), "--json"]],
            "artifacts": [],
        },
        "ui-viewports": {
            "category": "test",
            "cwd": ROOT,
            "commands": [[npm, "run", "test:ui-viewports"]],
            "artifacts": [
                "assets/resource/ShiKong/reports/playwright-workbench/report.json",
            ],
        },
    }
    profile = profiles[args.profile]
    command_text = " && ".join(" ".join(command) for command in profile["commands"])
    stamp = utc_now().replace(":", "").replace("-", "")
    command_id = "CMD-{}-{}".format(stamp, hashlib.sha256((args.profile + command_text).encode("utf-8")).hexdigest()[:8])
    output_dir = ROOT / "assets" / "resource" / "ShiKong" / "reports" / "dev-progress" / command_id
    output_dir.mkdir(parents=True, exist_ok=False)
    outputs: List[str] = []
    return_code = 0
    for command in profile["commands"]:
        outputs.append("$ {}\n".format(" ".join(command)))
        try:
            completed = subprocess.run(
                command,
                cwd=str(profile["cwd"]),
                shell=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=args.timeout_seconds,
            )
            outputs.append(completed.stdout)
            return_code = completed.returncode
        except subprocess.TimeoutExpired as exc:
            outputs.append((exc.stdout or "") if isinstance(exc.stdout, str) else "")
            outputs.append("\nTIMEOUT after {} seconds\n".format(args.timeout_seconds))
            return_code = 124
        if return_code != 0:
            break
    log_path = output_dir / "command.log"
    log_path.write_text("".join(outputs), encoding="utf-8")
    evidence_args = argparse.Namespace(
        id=None,
        category=profile["category"],
        claim=args.claim,
        status="passed" if return_code == 0 else "failed",
        command=command_text,
        target_identity=None,
        window_evidence_id=None,
        window_hwnd=None,
        window_pid=None,
        window_title=None,
        window_process=None,
        client_width=None,
        client_height=None,
        privilege=None,
        exit_code=return_code,
        criterion=args.criterion,
        artifact=[log_path.relative_to(ROOT).as_posix()] + list(profile["artifacts"]),
        input_sent=False,
        foreground_unchanged=None,
        cursor_unchanged=None,
        window_identity_verified=None,
        postcondition_observed=None,
        capture_method="profile_runner",
        runner_profile=args.profile,
        verifier=None,
    )
    record_evidence(evidence_args, allow_passed=True)
    print(log_path)
    if return_code != 0:
        raise RuntimeError("evidence command failed with exit code {}".format(return_code))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Maintain long-running execution progress metadata")
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    render_parser = subparsers.add_parser("render", help="refresh Git fields and regenerate STATUS.md")
    render_parser.set_defaults(func=command_render)

    resume_check_parser = subparsers.add_parser("resume-check", help="read-only recovery assessment; never updates progress state")
    resume_check_parser.add_argument("--json", action="store_true")
    resume_check_parser.set_defaults(func=command_resume_check)

    note_parser = subparsers.add_parser("note", help="append an important event")
    note_parser.add_argument("--type", required=True, choices=sorted(EVENT_TYPES))
    note_parser.add_argument("--summary", required=True)
    note_parser.add_argument("--detail")
    note_parser.add_argument("--next-action")
    note_parser.add_argument("--next-command", action="append")
    note_parser.add_argument("--blocker", action="append")
    note_parser.add_argument("--do-not", action="append")
    note_parser.set_defaults(func=command_note)

    begin_parser = subparsers.add_parser("begin-slice", help="start one bounded vertical slice")
    begin_parser.add_argument("--phase", required=True)
    begin_parser.add_argument("--slice", required=True)
    begin_parser.add_argument("--title", required=True)
    begin_parser.add_argument("--next-action", required=True)
    begin_parser.add_argument("--criterion", action="append", help="ID|category[,category]=acceptance text")
    begin_parser.add_argument("--scope", action="append")
    begin_parser.add_argument("--non-goal", action="append")
    begin_parser.add_argument("--safety-boundary", action="append")
    begin_parser.set_defaults(func=command_begin_slice)

    action_start = subparsers.add_parser("action-start", help="persist intent before a side effect")
    action_start.add_argument("--action-id", required=True)
    action_start.add_argument("--kind", required=True)
    action_start.add_argument("--target", required=True)
    action_start.add_argument("--side-effect-class", required=True)
    action_start.add_argument("--precondition", required=True)
    action_start.add_argument("--postcondition", required=True)
    action_start.add_argument("--idempotency-key", required=True)
    action_start.add_argument("--ownership-evidence", action="append")
    action_start.add_argument("--source")
    action_start.add_argument("--destination")
    action_start.add_argument("--expected-source-sha256")
    action_start.set_defaults(func=command_action_start)

    action_finish = subparsers.add_parser("action-finish", help="record a side-effect result")
    action_finish.add_argument("--action-id", required=True)
    action_finish.add_argument("--status", required=True, choices=["succeeded", "failed", "unknown_after_interruption"])
    action_finish.add_argument("--result", required=True)
    action_finish.set_defaults(func=command_action_finish)

    evidence_parser = subparsers.add_parser("evidence", help="append test or runtime evidence")
    evidence_parser.add_argument("--id")
    evidence_parser.add_argument("--category", required=True, choices=sorted(EVIDENCE_CATEGORIES))
    evidence_parser.add_argument("--claim", required=True)
    evidence_parser.add_argument("--status", required=True, choices=sorted(EVIDENCE_STATUSES))
    evidence_parser.add_argument("--command")
    evidence_parser.add_argument("--target-identity")
    evidence_parser.add_argument("--window-evidence-id")
    evidence_parser.add_argument("--window-hwnd")
    evidence_parser.add_argument("--window-pid", type=int)
    evidence_parser.add_argument("--window-title")
    evidence_parser.add_argument("--window-process")
    evidence_parser.add_argument("--client-width", type=int)
    evidence_parser.add_argument("--client-height", type=int)
    evidence_parser.add_argument("--privilege", choices=["same", "elevated", "insufficient", "unknown"])
    evidence_parser.add_argument("--exit-code", type=int)
    evidence_parser.add_argument("--criterion", action="append")
    evidence_parser.add_argument("--artifact", action="append")
    evidence_parser.add_argument("--input-sent", action="store_true")
    evidence_parser.add_argument("--foreground-unchanged", action="store_true", default=None)
    evidence_parser.add_argument("--cursor-unchanged", action="store_true", default=None)
    evidence_parser.add_argument("--window-identity-verified", action="store_true", default=None)
    evidence_parser.add_argument("--postcondition-observed", action="store_true", default=None)
    evidence_parser.set_defaults(func=command_evidence)

    gate_parser = subparsers.add_parser("gate", help="update one product verification axis")
    gate_parser.add_argument("--name", required=True)
    gate_parser.add_argument("--status", required=True, choices=sorted(GATE_STATUSES))
    gate_parser.add_argument("--note", required=True)
    gate_parser.add_argument("--evidence", action="append")
    gate_parser.set_defaults(func=command_gate)

    checkpoint_parser = subparsers.add_parser("checkpoint", help="create an immutable state snapshot")
    checkpoint_parser.add_argument("--label", required=True)
    checkpoint_parser.add_argument("--type", required=True, choices=["state_snapshot", "git_checkpoint"])
    checkpoint_parser.add_argument("--reason", required=True)
    checkpoint_parser.add_argument("--safe-to-resume", action="store_true")
    checkpoint_parser.add_argument("--safe-to-run-live-input", action="store_true")
    checkpoint_parser.set_defaults(func=command_checkpoint)

    slice_state_parser = subparsers.add_parser("slice-state", help="change the active phase/slice state")
    slice_state_parser.add_argument("--phase-status", required=True, choices=sorted(PHASE_STATUSES))
    slice_state_parser.add_argument("--slice-status", required=True, choices=["ready", "in_progress", "verifying", "verified", "blocked"])
    slice_state_parser.add_argument("--summary", required=True)
    slice_state_parser.add_argument("--next-action")
    slice_state_parser.add_argument("--blocker", action="append")
    slice_state_parser.set_defaults(func=command_slice_state)

    criterion_policy_parser = subparsers.add_parser("criterion-policy", help="set allowed evidence categories for one pending criterion")
    criterion_policy_parser.add_argument("--criterion", required=True)
    criterion_policy_parser.add_argument("--category", action="append", required=True, choices=sorted(EVIDENCE_CATEGORIES))
    criterion_policy_parser.set_defaults(func=command_criterion_policy)

    process_parser = subparsers.add_parser("process-observation", help="record a read-only observation for one external process")
    process_parser.add_argument("--pid", required=True, type=int)
    present_group = process_parser.add_mutually_exclusive_group(required=True)
    present_group.add_argument("--present", action="store_true")
    present_group.add_argument("--absent", dest="present", action="store_false")
    process_parser.add_argument("--name")
    process_parser.add_argument("--role")
    process_parser.add_argument("--ownership", default="preexisting")
    process_parser.add_argument("--creation-time")
    process_parser.add_argument("--identity-limit")
    process_parser.add_argument("--summary", required=True)
    process_parser.set_defaults(func=command_process_observation)

    reconcile_parser = subparsers.add_parser("reconcile", help="resume after interruption and align state tails")
    reconcile_parser.add_argument("--summary", required=True)
    reconcile_parser.add_argument("--next-action")
    reconcile_parser.add_argument("--thread-id")
    reconcile_parser.add_argument("--increment-attempt", action="store_true")
    reconcile_parser.set_defaults(func=command_reconcile)

    repair_parser = subparsers.add_parser("repair-tail", help="quarantine and remove only a corrupted final JSONL fragment")
    repair_parser.add_argument("--ledger", required=True, choices=["events", "evidence"])
    repair_parser.add_argument("--summary", required=True)
    repair_parser.add_argument("--confirm-quarantine-truncated-tail", action="store_true")
    repair_parser.set_defaults(func=command_repair_tail)

    run_parser = subparsers.add_parser("run-evidence", help="execute a bounded audit/test/build and record its real exit code and log")
    run_parser.add_argument("--profile", required=True, choices=["node-all", "python-audits", "frontend-build", "rust-static", "p0-preflight", "home-vitality-offline", "save-coordinator-offline", "asset-store-offline", "workspace-persistence-offline", "welfare-sign-in-offline", "bag-organize-offline", "p0-safety-boundary", "ui-viewports"])
    run_parser.add_argument("--claim", required=True)
    run_parser.add_argument("--criterion", action="append")
    run_parser.add_argument("--timeout-seconds", type=int, default=1800)
    run_parser.set_defaults(func=command_run_evidence)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.func(args)
    except Exception as exc:
        print("execution progress update failed: {}".format(exc), file=sys.stderr)
        return 1
    return int(result or 0)


if __name__ == "__main__":
    raise SystemExit(main())
