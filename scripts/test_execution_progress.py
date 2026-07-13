#!/usr/bin/env python3
"""Focused regression tests for the repository continuity writer."""

from __future__ import print_function

import argparse
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

import execution_progress as progress
import verify_p0_workspace_backup as backup_verifier


SOURCE_ROOT = Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def temporary_work_dir(prefix: str):
    """Windows-safe temp dir: git repos under TemporaryDirectory can hang on cleanup."""
    temp = tempfile.mkdtemp(prefix=prefix)
    try:
        yield temp
    finally:
        shutil.rmtree(temp, ignore_errors=True)



def git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git"] + list(args),
        cwd=str(root),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout.rstrip("\r\n")


class PatchedProgressPaths:
    def __init__(self, root: Path, external_root: Path) -> None:
        self.root = root
        self.external_root = external_root
        self.originals = {}

    def __enter__(self) -> "PatchedProgressPaths":
        names = [
            "ROOT",
            "EXECUTION_DIR",
            "STATE_PATH",
            "STATUS_PATH",
            "EVENTS_PATH",
            "EVIDENCE_PATH",
            "CHECKPOINT_DIR",
            "EXTERNAL_LEASE_PATH",
        ]
        for name in names:
            self.originals[name] = getattr(progress, name)
        progress.ROOT = self.root
        progress.EXECUTION_DIR = self.root / "docs" / "execution"
        progress.STATE_PATH = progress.EXECUTION_DIR / "state.json"
        progress.STATUS_PATH = progress.EXECUTION_DIR / "STATUS.md"
        progress.EVENTS_PATH = progress.EXECUTION_DIR / "events.jsonl"
        progress.EVIDENCE_PATH = progress.EXECUTION_DIR / "evidence.jsonl"
        progress.CHECKPOINT_DIR = progress.EXECUTION_DIR / "checkpoints"
        progress.EXTERNAL_LEASE_PATH = self.external_root / "external-action-lease.json"
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        for name, value in self.originals.items():
            setattr(progress, name, value)


def create_clean_progress_repo(base: Path) -> Path:
    root = base / "repo"
    root.mkdir(parents=True)
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "continuity-test@example.invalid")
    git(root, "config", "user.name", "Continuity Test")
    (root / "docs" / "execution").mkdir(parents=True)
    state = json.loads((SOURCE_ROOT / "docs" / "execution" / "state.json").read_text(encoding="utf-8"))
    state["revision"] = 1
    state["updatedAt"] = progress.utc_now()
    state["eventTail"] = {"seq": 0, "id": None, "hash": None}
    state["evidenceTail"] = {"seq": 0, "id": None, "hash": None}
    state["checkpointCounter"] = 0
    state["lastCheckpoint"] = None
    state["inFlightAction"] = None
    state["lastAction"] = None
    state["actionStatus"] = "none"
    for gate in state.get("projectVerification", {}).values():
        if gate.get("status") == "passed":
            gate["status"] = "pending"
            gate["evidenceIds"] = []
    for criterion in state.get("activeSlice", {}).get("acceptanceCriteria", []):
        criterion["status"] = "pending"
        criterion["evidenceIds"] = []
    state["runtime"]["managedProcesses"] = []
    state["runtime"]["managedArtifacts"] = []
    state["runtime"]["observedExternalProcesses"] = []
    state["runtime"]["observedArtifacts"] = []
    state["resume"].pop("lastSafeResumeSnapshotId", None)
    state["resume"].pop("lastVerifiedGitCheckpointId", None)
    (root / "docs" / "execution" / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "docs" / "execution" / "events.jsonl").write_text("", encoding="utf-8")
    (root / "docs" / "execution" / "evidence.jsonl").write_text("", encoding="utf-8")
    (root / "docs" / "execution" / "STATUS.md").write_text("bootstrap\n", encoding="utf-8")
    (root / "README.md").write_text("test\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "initial")
    with PatchedProgressPaths(root, base / "external"):
        state = progress.load_json(progress.STATE_PATH)
        snapshot = progress.current_git_snapshot()
        state["git"].update(snapshot)
        state["git"]["verifiedHead"] = snapshot["observedHead"]
        state["git"]["lastKnownStableCommit"] = snapshot["observedHead"]
        progress.atomic_write_json(progress.STATE_PATH, state)
        progress.atomic_write_text(progress.STATUS_PATH, progress.render_status(state, [], []))
    git(root, "add", ".")
    git(root, "commit", "-m", "baseline state")
    with PatchedProgressPaths(root, base / "external"):
        state = progress.load_json(progress.STATE_PATH)
        snapshot = progress.current_git_snapshot()
        state["git"].update(snapshot)
        state["git"]["verifiedHead"] = snapshot["observedHead"]
        progress.atomic_write_json(progress.STATE_PATH, state)
        progress.atomic_write_text(progress.STATUS_PATH, progress.render_status(state, [], []))
    git(root, "add", ".")
    git(root, "commit", "-m", "clean verified head")
    return root


class ExecutionProgressTests(unittest.TestCase):
    def install_backup_test_criterion(self, criterion_id: str = "BACKUP-TEST-C1") -> None:
        state = progress.load_json(progress.STATE_PATH)
        state["activeSlice"]["acceptanceCriteria"] = [{
            "id": criterion_id,
            "text": "test backup",
            "status": "pending",
            "evidenceIds": [],
            "requiredEvidenceCategories": ["appdata_backup"],
        }]
        progress.atomic_write_json(progress.STATE_PATH, state)

    def backup_action_args(self, source: Path, destination: Path, action_id: str) -> argparse.Namespace:
        source_hash = progress.file_sha256(source).upper()
        return argparse.Namespace(
            action_id=action_id,
            kind="appdata_backup",
            target="{} -> {}".format(source.resolve(), destination.resolve()),
            side_effect_class="local_file_create",
            precondition="source identity matches and destination is absent",
            postcondition="destination hash and size match source",
            idempotency_key="{}+{}".format(source_hash, destination.resolve()),
            ownership_evidence=[str(destination.resolve()), "unit test action"],
            source=str(source.resolve()),
            destination=str(destination.resolve()),
            expected_source_sha256=source_hash,
        )

    def test_resume_check_is_read_only_and_reports_current_snapshot(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-resume-check-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                progress.command_render(argparse.Namespace())
                tracked = [progress.STATE_PATH, progress.STATUS_PATH, progress.EVENTS_PATH, progress.EVIDENCE_PATH]
                before = {path: (path.stat().st_mtime_ns, progress.file_sha256(path)) for path in tracked}
                report = progress.build_resume_report()
                after = {path: (path.stat().st_mtime_ns, progress.file_sha256(path)) for path in tracked}
                self.assertEqual(before, after)
                self.assertEqual(report["decision"], "safe_to_resume")
                self.assertFalse(report["workspaceDrift"])
                self.assertTrue(report["permissions"]["canRunReadOnlyChecks"])

    def test_verified_slice_is_archived_before_next_slice_in_same_phase(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-multi-slice-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                state = progress.load_json(progress.STATE_PATH)
                state["currentPhaseId"] = "P1"
                state["phaseStatus"] = "in_progress"
                state["completedSlices"] = []
                state["activeSlice"] = {
                    "id": "P1-S1",
                    "title": "first slice",
                    "status": "verified",
                    "acceptanceCriteria": [],
                    "nextAction": "start P1-S2",
                }
                for phase in state.get("phases", []):
                    if phase.get("id") == "P1":
                        phase["status"] = "in_progress"
                progress.atomic_write_json(progress.STATE_PATH, state)
                progress.command_begin_slice(argparse.Namespace(
                    phase="P1",
                    slice="P1-S2",
                    title="second slice",
                    next_action="implement second slice",
                    criterion=["P1-S2-C1|test=second slice passes"],
                    scope=["test"],
                    non_goal=[],
                    safety_boundary=[],
                ))
                next_state = progress.load_json(progress.STATE_PATH)
                self.assertEqual(next_state["activeSlice"]["id"], "P1-S2")
                self.assertEqual(next_state["phaseStatus"], "in_progress")
                self.assertEqual(next_state["completedSlices"][-1]["id"], "P1-S1")
                self.assertEqual(next_state["completedSlices"][-1]["phaseId"], "P1")

    def test_failed_criterion_policy_can_be_corrected_without_erasing_evidence(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-criterion-policy-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                state = progress.load_json(progress.STATE_PATH)
                state["activeSlice"] = {
                    "id": "P1-S3",
                    "title": "runtime cancellation",
                    "status": "in_progress",
                    "acceptanceCriteria": [{
                        "id": "P1-S3-C3",
                        "text": "static audit passes",
                        "status": "failed",
                        "evidenceIds": ["EVD-FAILED"],
                        "requiredEvidenceCategories": ["source_audit"],
                    }],
                    "nextAction": "correct evidence policy",
                }
                progress.atomic_write_json(progress.STATE_PATH, state)

                progress.command_criterion_policy(argparse.Namespace(
                    criterion="P1-S3-C3",
                    category=["test"],
                ))

                next_state = progress.load_json(progress.STATE_PATH)
                criterion = next_state["activeSlice"]["acceptanceCriteria"][0]
                self.assertEqual(criterion["status"], "pending")
                self.assertEqual(criterion["evidenceIds"], ["EVD-FAILED"])
                self.assertEqual(criterion["requiredEvidenceCategories"], ["test"])

    def test_manual_runtime_passed_evidence_is_rejected_before_persist(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-provenance-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                evidence = argparse.Namespace(
                    id=None,
                    category="runtime_observation",
                    claim="forged runtime pass",
                    status="passed",
                    command=None,
                    target_identity=None,
                    window_evidence_id=None,
                    window_hwnd=None,
                    window_pid=None,
                    window_title=None,
                    window_process=None,
                    client_width=None,
                    client_height=None,
                    privilege=None,
                    exit_code=None,
                    criterion=None,
                    artifact=None,
                    input_sent=False,
                    foreground_unchanged=None,
                    cursor_unchanged=None,
                    window_identity_verified=None,
                    postcondition_observed=None,
                )
                with self.assertRaises(RuntimeError):
                    progress.command_evidence(evidence)
                self.assertEqual(progress.load_jsonl(progress.EVIDENCE_PATH), [])

    def test_unknown_action_requires_specialized_reconciliation(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-unknown-finish-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                start = argparse.Namespace(
                    action_id="ACT-UNKNOWN-001",
                    kind="file_create",
                    target="local-marker.txt",
                    side_effect_class="local_file_create",
                    precondition="target absent",
                    postcondition="target exists",
                    idempotency_key="unknown-finish-test",
                    ownership_evidence=["test fixture"],
                )
                progress.command_action_start(start)
                progress.command_action_finish(argparse.Namespace(
                    action_id="ACT-UNKNOWN-001",
                    status="unknown_after_interruption",
                    result="simulated interruption",
                ))
                with self.assertRaises(RuntimeError):
                    progress.command_action_finish(argparse.Namespace(
                        action_id="ACT-UNKNOWN-001",
                        status="succeeded",
                        result="free-form claim must not resolve unknown",
                    ))
                state = progress.load_json(progress.STATE_PATH)
                self.assertEqual(state["actionStatus"], "unknown_after_interruption")
                self.assertEqual(state["inFlightAction"]["actionId"], "ACT-UNKNOWN-001")

    def test_owner_reconcile_releases_lease_left_after_persisted_result(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-stale-lease-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                source = base / "workspace.json"
                destination = base / "workspace.crash-backup.json"
                source.write_text('{"schemaVersion":6}\n', encoding="utf-8")
                start = argparse.Namespace(
                    action_id="ACT-LEASE-CRASH-001",
                    kind="process_start",
                    target="test-process",
                    side_effect_class="process_start",
                    precondition="target absent",
                    postcondition="hash matches",
                    idempotency_key="stale-lease-crash-test",
                    ownership_evidence=["test fixture"],
                )
                progress.command_action_start(start)
                original_release = progress.release_external_action_lease
                try:
                    progress.release_external_action_lease = lambda action_id, token: (_ for _ in ()).throw(RuntimeError("simulated crash after persist"))
                    with self.assertRaises(RuntimeError):
                        progress.command_action_finish(argparse.Namespace(
                            action_id="ACT-LEASE-CRASH-001",
                            status="succeeded",
                            result="result persisted before simulated crash",
                        ))
                finally:
                    progress.release_external_action_lease = original_release
                state = progress.load_json(progress.STATE_PATH)
                self.assertIsNone(state["inFlightAction"])
                self.assertTrue(progress.EXTERNAL_LEASE_PATH.exists())
                progress.command_reconcile(argparse.Namespace(
                    summary="owner removes lease left after persisted action result",
                    next_action=None,
                    thread_id=None,
                    increment_attempt=True,
                ))
                self.assertFalse(progress.EXTERNAL_LEASE_PATH.exists())
                self.assertFalse(progress.action_token_path("ACT-LEASE-CRASH-001").exists())

    def test_profile_category_and_specialized_verifier_are_allowlisted(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-provenance-map-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                base_args = {
                    "id": None,
                    "claim": "forged evidence",
                    "status": "passed",
                    "command": "echo forged",
                    "target_identity": None,
                    "window_evidence_id": None,
                    "window_hwnd": None,
                    "window_pid": None,
                    "window_title": None,
                    "window_process": None,
                    "client_width": None,
                    "client_height": None,
                    "privilege": None,
                    "exit_code": 0,
                    "criterion": None,
                    "artifact": None,
                    "input_sent": False,
                    "foreground_unchanged": None,
                    "cursor_unchanged": None,
                    "window_identity_verified": None,
                    "postcondition_observed": None,
                }
                forged_profile = argparse.Namespace(
                    **dict(base_args, category="test", capture_method="profile_runner", runner_profile="frontend-build", verifier=None)
                )
                with self.assertRaises(RuntimeError):
                    progress.record_evidence(forged_profile, allow_passed=True)
                forged_verifier = argparse.Namespace(
                    **dict(base_args, category="app_runtime", capture_method="specialized_verifier", runner_profile=None, verifier="unregistered-verifier", artifact=["README.md"])
                )
                with self.assertRaises(RuntimeError):
                    progress.record_evidence(forged_verifier, allow_passed=True)
                
                self.assertIn("current-app-launch-v1", progress.SPECIALIZED_VERIFIER_ALLOWLIST["app_runtime"])
                self.assertIn("window-identity-v1", progress.SPECIALIZED_VERIFIER_ALLOWLIST["window_identity"])
                self.assertEqual(progress.load_jsonl(progress.EVIDENCE_PATH), [])

    def test_resume_check_returns_blocked_for_malformed_ledger(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-malformed-resume-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                progress.EVENTS_PATH.write_text("{broken", encoding="utf-8")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    exit_code = progress.command_resume_check(argparse.Namespace(json=True))
                report = json.loads(output.getvalue())
                self.assertEqual(exit_code, 3)
                self.assertEqual(report["decision"], "blocked")
                self.assertFalse(report["permissions"]["canStartSideEffect"])

    def test_checkpoint_diff_hash_includes_staged_changes(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-staged-diff-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                staged = root / "staged-only.txt"
                staged.write_text("staged content\n", encoding="utf-8")
                git(root, "add", "staged-only.txt")
                expected = subprocess.run(
                    ["git", "diff", "HEAD", "--binary"],
                    cwd=str(root),
                    check=True,
                    stdout=subprocess.PIPE,
                ).stdout
                progress.command_checkpoint(argparse.Namespace(
                    label="staged-diff",
                    type="state_snapshot",
                    reason="verify staged diff coverage",
                    safe_to_resume=True,
                    safe_to_run_live_input=False,
                ))
                state = progress.load_json(progress.STATE_PATH)
                checkpoint = progress.load_json(root / state["lastCheckpoint"]["path"])
                import hashlib
                self.assertEqual(checkpoint["gitDiffSha256"], hashlib.sha256(expected).hexdigest())

    def test_status_prioritizes_unknown_action_and_stale_runtime(self) -> None:
        state = json.loads((SOURCE_ROOT / "docs" / "execution" / "state.json").read_text(encoding="utf-8"))
        state["projectVerification"]["automated"] = {
            "status": "passed",
            "note": "test fixture with no current evidence",
            "evidenceIds": ["EVD-STALE-TEST"],
        }
        state["runtime"]["observedAt"] = "2000-01-01T00:00:00Z"
        state["inFlightAction"] = {
            "actionId": "ACT-STALE-001",
            "kind": "appdata_backup",
            "status": "unknown_after_interruption",
            "targetIdentity": "workspace.backup.json",
            "sideEffectClass": "local_file_create",
        }
        state["actionStatus"] = "unknown_after_interruption"
        rendered = progress.render_status(state, [], [])
        first_screen = "\n".join(rendered.splitlines()[:45])
        self.assertIn("STOP：存在未决副作用", first_screen)
        self.assertIn("对账未决副作用动作 ACT-STALE-001", first_screen)
        self.assertIn("运行观察（STATUS 生成时）：**已过期**", first_screen)
        self.assertIn("| 自动测试 | `已过期` |", rendered)

    def test_status_escapes_multiline_list_content(self) -> None:
        state = json.loads((SOURCE_ROOT / "docs" / "execution" / "state.json").read_text(encoding="utf-8"))
        state["activeSlice"]["scope"] = ["scope line\n## injected-heading"]
        rendered = progress.render_status(state, [], [])
        self.assertIn("- scope line<br>## injected-heading", rendered)
        self.assertNotIn("\n## injected-heading", rendered)

    def test_execution_metadata_rename_to_source_counts_as_product_drift(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-rename-boundary-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                source = root / "docs" / "execution" / "rename-source.txt"
                source.write_text("rename boundary\n", encoding="utf-8")
                git(root, "add", ".")
                git(root, "commit", "-m", "add metadata rename source")
                destination = root / "src" / "rename-destination.txt"
                destination.parent.mkdir(parents=True, exist_ok=True)
                git(root, "mv", "docs/execution/rename-source.txt", "src/rename-destination.txt")
                snapshot = progress.current_git_snapshot()
                self.assertTrue(progress.non_metadata_dirty_paths(snapshot))
                self.assertTrue(any("docs/execution/rename-source.txt -> src/rename-destination.txt" in path for path in snapshot["dirtyPaths"]))

    def test_clean_repo_note_records_its_own_dirty_paths(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-clean-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                args = argparse.Namespace(
                    type="decision",
                    summary="first note from clean repository",
                    detail=None,
                    next_action=None,
                    next_command=None,
                )
                progress.command_note(args)
                state = progress.load_json(progress.STATE_PATH)
                actual = progress.current_git_snapshot()
                self.assertEqual(state["git"]["dirtyPaths"], actual["dirtyPaths"])
                self.assertIn("docs/execution/events.jsonl", actual["dirtyPaths"])
                self.assertIn("docs/execution/state.json", actual["dirtyPaths"])
                self.assertIn("docs/execution/STATUS.md", actual["dirtyPaths"])

    def test_linked_worktree_uses_git_resolved_lock_path(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-worktree-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            worktree = base / "linked"
            git(root, "worktree", "add", "--detach", str(worktree), "HEAD")
            self.assertTrue((worktree / ".git").is_file())
            with PatchedProgressPaths(worktree, base / "external"):
                lock_path = progress.progress_lock_path()
                self.assertNotEqual(lock_path, worktree / ".git" / "codex-execution.lock")
                with progress.ProgressLock(lock_path):
                    self.assertTrue(lock_path.exists())

    def test_porcelain_z_preserves_spaces_unicode_and_rename(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-paths-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            original = root / "名称 old.txt"
            original.write_text("x", encoding="utf-8")
            git(root, "add", ".")
            git(root, "commit", "-m", "add unicode path")
            renamed = root / " leading new 名称.txt"
            original.rename(renamed)
            git(root, "add", "-A")
            with PatchedProgressPaths(root, base / "external"):
                snapshot = progress.current_git_snapshot()
                display = "名称 old.txt ->  leading new 名称.txt"
                self.assertIn(display, snapshot["dirtyPaths"])

    def test_unknown_action_stays_in_flight_and_blocks_new_action(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-action-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                start = argparse.Namespace(
                    action_id="ACT-TEST-001",
                    kind="git_commit",
                    target="temp repo",
                    side_effect_class="git_commit",
                    precondition="dirty tree exists",
                    postcondition="commit exists",
                    idempotency_key="test-commit-001",
                    ownership_evidence=[],
                )
                progress.command_action_start(start)
                finish = argparse.Namespace(
                    action_id="ACT-TEST-001",
                    status="unknown_after_interruption",
                    result="simulated interruption",
                )
                progress.command_action_finish(finish)
                state = progress.load_json(progress.STATE_PATH)
                self.assertEqual(state["actionStatus"], "unknown_after_interruption")
                self.assertEqual(state["inFlightAction"]["actionId"], "ACT-TEST-001")
                second = copy.copy(start)
                second.action_id = "ACT-TEST-002"
                second.idempotency_key = "test-commit-002"
                with self.assertRaises(RuntimeError):
                    progress.command_action_start(second)

    def test_repair_tail_quarantines_only_the_final_fragment(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-repair-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                args = argparse.Namespace(
                    type="decision",
                    summary="valid event before corruption",
                    detail=None,
                    next_action=None,
                    next_command=None,
                )
                progress.command_note(args)
                with progress.EVENTS_PATH.open("ab") as handle:
                    handle.write(b'{"truncated"')
                repair = argparse.Namespace(
                    ledger="events",
                    summary="quarantine simulated truncated tail",
                    confirm_quarantine_truncated_tail=True,
                )
                progress.command_repair_tail(repair)
                records = progress.load_jsonl(progress.EVENTS_PATH)
                self.assertEqual(records[-1]["eventType"], "reconciliation")
                fragments = list((progress.EXECUTION_DIR / "recovery-fragments").glob("*-events-truncated-tail.bin"))
                self.assertEqual(len(fragments), 1)
                self.assertEqual(fragments[0].read_bytes(), b'{"truncated"')

    def test_unknown_evidence_category_and_pending_verification_fail_closed(self) -> None:
        parser = progress.build_parser()
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(["evidence", "--category", "banana", "--claim", "invalid", "--status", "passed"])
        with temporary_work_dir(prefix="mhxy-progress-verify-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                args = argparse.Namespace(
                    phase_status="verified",
                    slice_status="verified",
                    summary="must fail with pending criteria",
                    next_action=None,
                    blocker=None,
                )
                with self.assertRaises(RuntimeError):
                    progress.command_slice_state(args)

    def test_repair_tail_rejects_complete_hash_mismatch(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-hash-repair-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                args = argparse.Namespace(
                    type="decision",
                    summary="valid event before tamper",
                    detail=None,
                    next_action=None,
                    next_command=None,
                )
                progress.command_note(args)
                records = progress.load_jsonl(progress.EVENTS_PATH)
                records[-1]["summary"] = "tampered but complete"
                progress.EVENTS_PATH.write_text("".join(progress.canonical_json(record) + "\n" for record in records), encoding="utf-8")
                repair = argparse.Namespace(
                    ledger="events",
                    summary="must not remove complete tampered record",
                    confirm_quarantine_truncated_tail=True,
                )
                with self.assertRaises(RuntimeError):
                    progress.command_repair_tail(repair)

    def test_foreign_clone_cannot_release_machine_lease(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-lease-") as temp:
            base = Path(temp)
            root_a = create_clean_progress_repo(base / "a")
            root_b = create_clean_progress_repo(base / "b")
            external = base / "shared-external"
            start = argparse.Namespace(
                action_id="ACT-LEASE-001",
                kind="appdata_backup",
                target="workspace.test-backup.json",
                side_effect_class="local_file_create",
                precondition="destination absent",
                postcondition="hash matches",
                idempotency_key="lease-test-001",
                ownership_evidence=["test target"],
                source=str((base / "workspace.json").resolve()),
                destination=str((base / "workspace.test-backup.json").resolve()),
                expected_source_sha256="0" * 64,
            )
            (base / "workspace.json").write_text('{"schemaVersion":6}\n', encoding="utf-8")
            start.expected_source_sha256 = progress.file_sha256(base / "workspace.json").upper()
            start.target = "{} -> {}".format((base / "workspace.json").resolve(), (base / "workspace.test-backup.json").resolve())
            with PatchedProgressPaths(root_a, external):
                progress.command_action_start(start)
            with PatchedProgressPaths(root_b, external):
                reconcile = argparse.Namespace(
                    summary="foreign clone observes lease",
                    next_action="owner must reconcile",
                    thread_id=None,
                    increment_attempt=True,
                )
                progress.command_reconcile(reconcile)
                finish = argparse.Namespace(
                    action_id="ACT-LEASE-001",
                    status="failed",
                    result="foreign release must fail",
                )
                with self.assertRaises(RuntimeError):
                    progress.command_action_finish(finish)
            with PatchedProgressPaths(root_a, external):
                finish = argparse.Namespace(
                    action_id="ACT-LEASE-001",
                    status="failed",
                    result="owner resolves test lease",
                )
                progress.command_action_finish(finish)
                self.assertFalse(progress.EXTERNAL_LEASE_PATH.exists())

    def test_p0_backup_verifier_copies_exclusively_and_records_trusted_evidence(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-backup-verify-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            appdata = base / "appdata"
            appdata.mkdir()
            source = appdata / "workspace.json"
            destination = appdata / "migration-backups" / "workspace.schema-v6.test.json"
            source.write_text('{"schemaVersion":6,"workflows":[]}\n', encoding="utf-8")
            with PatchedProgressPaths(root, base / "external"):
                criterion_id = "BACKUP-TEST-C1"
                self.install_backup_test_criterion(criterion_id)
                progress.command_action_start(self.backup_action_args(source, destination, "ACT-P0-BACKUP-TEST-001"))
                result = backup_verifier.verify_and_copy(
                    "ACT-P0-BACKUP-TEST-001",
                    criterion_id,
                    "python -B scripts/verify_p0_workspace_backup.py --test",
                )
                self.assertTrue(destination.is_file())
                self.assertEqual(progress.file_sha256(source), progress.file_sha256(destination))
                self.assertEqual(result["sourceSha256Before"], result["destinationSha256"])
                evidence = progress.load_jsonl(progress.EVIDENCE_PATH)
                self.assertEqual(len(evidence), 1)
                self.assertEqual(evidence[0]["provenance"]["verifier"], backup_verifier.VERIFIER_NAME)
                state = progress.load_json(progress.STATE_PATH)
                criterion = next(item for item in state["activeSlice"]["acceptanceCriteria"] if item["id"] == criterion_id)
                self.assertEqual(criterion["status"], "passed")
                self.assertEqual(state["actionStatus"], "succeeded")
                self.assertIsNone(state["inFlightAction"])
                self.assertFalse(progress.EXTERNAL_LEASE_PATH.exists())
                (root / "product-change.txt").write_text("later repository work\n", encoding="utf-8")
                state["git"].update(progress.current_git_snapshot())
                progress.atomic_write_json(progress.STATE_PATH, state)
                applicability, _ = progress.evidence_applicability(evidence[0], state)
                self.assertEqual(applicability, "valid")
                self.assertTrue(progress.evidence_satisfies_criterion(criterion, evidence[0], state))

    def test_p0_backup_intent_rejects_existing_destination_and_verifier_rejects_changed_source(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-backup-gates-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            appdata = base / "appdata"
            appdata.mkdir()
            source = appdata / "workspace.json"
            source.write_text('{"schemaVersion":6}\n', encoding="utf-8")
            existing = appdata / "existing.json"
            existing.write_text("do not overwrite\n", encoding="utf-8")
            destination = appdata / "new.json"
            with PatchedProgressPaths(root, base / "external"):
                with self.assertRaises(RuntimeError):
                    progress.command_action_start(self.backup_action_args(source, existing, "ACT-P0-BACKUP-TEST-002"))
                progress.command_action_start(self.backup_action_args(source, destination, "ACT-P0-BACKUP-TEST-003"))
                source.write_text('{"schemaVersion":6,"changed":true}\n', encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    backup_verifier.verify_and_copy(
                        "ACT-P0-BACKUP-TEST-003",
                        "P0-S1-C1",
                        "python -B scripts/verify_p0_workspace_backup.py --test",
                    )
                self.assertFalse(destination.exists())
                state = progress.load_json(progress.STATE_PATH)
                self.assertEqual(state["actionStatus"], "running")
                with self.assertRaises(RuntimeError):
                    progress.command_action_finish(argparse.Namespace(
                        action_id="ACT-P0-BACKUP-TEST-003",
                        status="succeeded",
                        result="free-form success must be rejected",
                    ))
                progress.command_action_finish(argparse.Namespace(
                    action_id="ACT-P0-BACKUP-TEST-003",
                    status="failed",
                    result="unit test changed the source after intent",
                ))

    def test_safe_live_checkpoint_rejects_unverified_head(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-prelive-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                state = progress.load_json(progress.STATE_PATH)
                state["git"].update(progress.current_git_snapshot())
                state["git"]["verifiedHead"] = "0" * 40
                state["projectVerification"]["currentCommitBuilt"] = {"status": "passed", "note": "test", "evidenceIds": ["test"]}
                state["projectVerification"]["currentCommitAppLaunched"] = {"status": "passed", "note": "test", "evidenceIds": ["test"]}
                state["runtime"]["lastWindowIdentity"] = {
                    "targetIdentity": "hwnd:test",
                    "verified": True,
                    "observedAt": progress.utc_now(),
                    "evidenceId": "window-test",
                    "identity": {"privilege": "same"},
                }
                progress.atomic_write_json(progress.STATE_PATH, state)
                checkpoint = argparse.Namespace(
                    label="pre-live-test",
                    type="state_snapshot",
                    reason="must reject stale verified head",
                    safe_to_resume=True,
                    safe_to_run_live_input=True,
                )
                with self.assertRaises(RuntimeError):
                    progress.command_checkpoint(checkpoint)

    def test_action_id_path_escape_and_manual_build_evidence_are_rejected(self) -> None:
        with temporary_work_dir(prefix="mhxy-progress-failclosed-") as temp:
            base = Path(temp)
            root = create_clean_progress_repo(base)
            with PatchedProgressPaths(root, base / "external"):
                with self.assertRaises(RuntimeError):
                    progress.action_token_path("../../../outside")
                evidence = argparse.Namespace(
                    id=None,
                    category="build",
                    claim="forged build",
                    status="passed",
                    command="fake build",
                    target_identity=None,
                    window_evidence_id=None,
                    window_hwnd=None,
                    window_pid=None,
                    window_title=None,
                    window_process=None,
                    client_width=None,
                    client_height=None,
                    privilege=None,
                    exit_code=0,
                    criterion=None,
                    artifact=["README.md"],
                    input_sent=False,
                    foreground_unchanged=None,
                    cursor_unchanged=None,
                    window_identity_verified=None,
                    postcondition_observed=None,
                )
                with self.assertRaises(RuntimeError):
                    progress.command_evidence(evidence)


if __name__ == "__main__":
    unittest.main(verbosity=2)
