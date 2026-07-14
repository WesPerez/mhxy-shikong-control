#!/usr/bin/env python3
"""Verify a bounded home-vitality live step through the elevated PostMessage path."""

from __future__ import annotations

import argparse
import json
import os
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import execution_progress as progress


VERIFIER_NAME = "bounded-live-input-v1"
STEP_MARKER = "BOUNDED_LIVE_STEP_JSON="
INPUT_ELIGIBLE_PRIVILEGES = {"same", "elevated"}
GAME_CLIENT_ROLE = "game-client"
GAME_CLIENT_PROCESS = "mygame_x64r.exe"
ALLOWED_TEMPLATE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp"}
ALLOWED_MODES = {"match_only", "hotkey", "image_click"}
LIVE_CATEGORIES = {"live_input", "live_outcome"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def report_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def parse_roi(value: str) -> Tuple[int, int, int, int]:
    parts = [item.strip() for item in value.split(",")]
    if len(parts) != 4:
        raise RuntimeError("--roi must use x,y,width,height")
    try:
        roi = tuple(int(item) for item in parts)
    except ValueError as exc:
        raise RuntimeError("--roi must contain integers") from exc
    if any(item < 0 for item in roi) or roi[2] <= 0 or roi[3] <= 0:
        raise RuntimeError("--roi requires non-negative x/y and positive width/height")
    return roi  # type: ignore[return-value]


def resolve_template_path(raw_path: str, root: Path = progress.ROOT) -> Path:
    candidate = Path(raw_path)
    path = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    template_root = (root / "assets" / "resource" / "ShiKong").resolve()
    try:
        path.relative_to(template_root)
    except ValueError as exc:
        raise RuntimeError("template must remain under assets/resource/ShiKong") from exc
    if path.suffix.lower() not in ALLOWED_TEMPLATE_SUFFIXES:
        raise RuntimeError("template must be a png, jpg, jpeg, or bmp image")
    if not path.is_file():
        raise RuntimeError("template image is missing: {}".format(path))
    return path


def current_git_binding(state: Dict[str, Any]) -> Dict[str, str]:
    state_git = state.get("git") or {}
    snapshot = progress.current_git_snapshot()
    observed_head = state_git.get("observedHead")
    fingerprint = state_git.get("workingTreeFingerprint")
    if not observed_head or not fingerprint:
        raise RuntimeError("execution state lacks a current source binding")
    if (
        snapshot.get("observedHead") != observed_head
        or snapshot.get("workingTreeFingerprint") != fingerprint
    ):
        raise RuntimeError("source workspace changed before bounded live verification")
    return {
        "observedHead": observed_head,
        "workingTreeFingerprint": fingerprint,
    }

def criterion_binding(state: Dict[str, Any], criterion_id: str, category: str) -> Dict[str, Any]:
    active_slice = state.get("activeSlice") or {}
    slice_id = active_slice.get("id")
    if not isinstance(slice_id, str) or not slice_id:
        raise RuntimeError("bounded live verifier requires an active slice id")
    active_criteria = {
        item.get("id"): item for item in active_slice.get("acceptanceCriteria", [])
    }
    criterion = active_criteria.get(criterion_id)
    required_categories = criterion.get("requiredEvidenceCategories", []) if criterion else []
    if (
        not criterion
        or not isinstance(required_categories, list)
        or category not in required_categories
    ):
        raise RuntimeError(
            "criterion is not an active {} acceptance criterion".format(category)
        )
    return {
        "sliceId": slice_id,
        "criterionId": criterion_id,
        "requiredEvidenceCategories": sorted(required_categories),
    }


def current_window_evidence(
    state: Dict[str, Any], evidence_id: str, records: List[Dict[str, Any]]
) -> Dict[str, Any]:
    record = next((item for item in records if item.get("id") == evidence_id), None)
    if not record:
        raise RuntimeError("window identity evidence does not exist: {}".format(evidence_id))
    if record.get("category") != "window_identity" or record.get("status") != "passed":
        raise RuntimeError("window evidence must be passed window_identity evidence")
    if not progress.evidence_provenance_valid(record):
        raise RuntimeError("window evidence lacks an allowlisted specialized verifier")
    if not record.get("safety", {}).get("windowIdentityVerified"):
        raise RuntimeError("window evidence does not verify its target identity")
    if not record.get("targetIdentity"):
        raise RuntimeError("window evidence lacks targetIdentity")
    identity = record.get("windowIdentity") or {}
    required = [
        identity.get("hwnd"),
        identity.get("pid"),
        identity.get("title"),
        identity.get("process"),
        identity.get("clientWidth"),
        identity.get("clientHeight"),
    ]
    if any(value in {None, ""} for value in required):
        raise RuntimeError("window evidence lacks required HWND identity fields")
    verification = record.get("verification")
    if not isinstance(verification, dict) or verification.get("role") != GAME_CLIENT_ROLE:
        raise RuntimeError("window evidence must verify a game-client role")
    if str(identity.get("process", "")).casefold() != GAME_CLIENT_PROCESS:
        raise RuntimeError("window evidence must verify the MyGame_x64r.exe process")
    if identity.get("privilege") not in INPUT_ELIGIBLE_PRIVILEGES:
        raise RuntimeError("window evidence privilege is not eligible for gated input")
    state_git = state.get("git") or {}
    evidence_git = record.get("git") or {}
    if (
        evidence_git.get("observedHead") != state_git.get("observedHead")
        or evidence_git.get("workingTreeFingerprint") != state_git.get("workingTreeFingerprint")
    ):
        raise RuntimeError("window evidence is stale for the current source workspace")
    captured_at = record.get("capturedAt")
    try:
        observed_at = datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("window evidence lacks a valid observation timestamp") from exc
    stale_after_seconds = int((state.get("runtime") or {}).get("staleAfterSeconds", 300))
    age_seconds = (datetime.now(timezone.utc) - observed_at).total_seconds()
    if age_seconds < -5 or age_seconds > stale_after_seconds:
        raise RuntimeError("window evidence is stale for bounded live input")
    return record


def optional_preflight_evidence(
    state: Dict[str, Any], evidence_id: Optional[str], records: List[Dict[str, Any]], target_identity: str
) -> Optional[Dict[str, Any]]:
    if not evidence_id:
        return None
    record = next((item for item in records if item.get("id") == evidence_id), None)
    if not record:
        raise RuntimeError("live_preflight evidence does not exist: {}".format(evidence_id))
    if record.get("category") != "live_preflight" or record.get("status") != "passed":
        raise RuntimeError("preflight evidence must be passed live_preflight evidence")
    if not progress.evidence_provenance_valid(record):
        raise RuntimeError("preflight evidence lacks an allowlisted specialized verifier")
    if record.get("safety", {}).get("inputSent") is not False:
        raise RuntimeError("preflight evidence must report inputSent=false")
    if record.get("targetIdentity") != target_identity:
        raise RuntimeError("preflight evidence target does not match window identity")
    state_git = state.get("git") or {}
    evidence_git = record.get("git") or {}
    if (
        evidence_git.get("observedHead") != state_git.get("observedHead")
        or evidence_git.get("workingTreeFingerprint") != state_git.get("workingTreeFingerprint")
    ):
        raise RuntimeError("preflight evidence is stale for the current source workspace")
    return record


def parse_manual_confirmation(raw: str) -> Dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("manual confirmation JSON is invalid") from exc
    if not isinstance(value, dict):
        raise RuntimeError("manual confirmation JSON must be an object")
    target_id = str(value.get("targetId") or value.get("target_id") or "").strip()
    fingerprint = str(
        value.get("bindingFingerprint") or value.get("binding_fingerprint") or ""
    ).strip()
    approved_at = str(value.get("approvedAt") or value.get("approved_at") or "").strip()
    if not target_id or not fingerprint or not approved_at:
        raise RuntimeError("manual confirmation requires targetId, bindingFingerprint, approvedAt")
    return {
        "version": int(value.get("version") or 1),
        "targetId": target_id,
        "bindingFingerprint": fingerprint,
        "approvedAt": approved_at,
    }

def build_step_command(
    mode: str,
    identity: Dict[str, Any],
    allow_input: bool,
    hotkey: Optional[str],
    template_path: Optional[Path],
    roi: Optional[Tuple[int, int, int, int]],
    threshold: float,
    target_id: Optional[str],
    binding_fingerprint: Optional[str],
    manual_confirmation: Optional[Dict[str, Any]],
    observe_ms: int,
    report_path: Path,
    elevated_target: bool,
) -> List[str]:
    command = [
        "cargo",
        "run",
        "--quiet",
        "--locked",
        "--manifest-path",
        str(progress.ROOT / "src-tauri" / "Cargo.toml"),
        "--bin",
        "bounded_live_step",
        "--",
        "--mode",
        mode,
        "--hwnd",
        str(identity["hwnd"]),
        "--pid",
        str(identity["pid"]),
        "--title",
        "*",
        "--process-name",
        str(identity["process"]),
        "--client-width",
        str(identity["clientWidth"]),
        "--client-height",
        str(identity["clientHeight"]),
        "--expected-elevated",
        "true" if elevated_target else "false",
        "--observe-ms",
        str(observe_ms),
        "--report-path",
        str(report_path),
    ]
    if allow_input:
        command.append("--allow-input")
    if hotkey:
        command.extend(["--hotkey", hotkey])
    if template_path is not None:
        command.extend(["--template", str(template_path)])
    if roi is not None:
        command.extend(["--roi", ",".join(str(value) for value in roi)])
    if mode in {"match_only", "image_click"}:
        command.extend(["--threshold", "{:.6f}".format(threshold)])
    if target_id:
        command.extend(["--target-id", target_id])
    if binding_fingerprint:
        command.extend(["--binding-fingerprint", binding_fingerprint])
    if manual_confirmation is not None:
        command.extend(
            [
                "--manual-confirmation-json",
                json.dumps(manual_confirmation, ensure_ascii=False, separators=(",", ":")),
            ]
        )
    return command


def parse_step_output(output: str, report_path: Path) -> Dict[str, Any]:
    if report_path.is_file():
        try:
            return json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError("bounded live step report file is malformed") from exc
    for line in reversed(output.splitlines()):
        if line.startswith(STEP_MARKER):
            try:
                parsed = json.loads(line[len(STEP_MARKER) :])
            except json.JSONDecodeError as exc:
                raise RuntimeError("bounded live step returned malformed JSON") from exc
            if not isinstance(parsed, dict):
                raise RuntimeError("bounded live step returned a non-object report")
            return parsed
    raise RuntimeError("bounded live step did not return a structured report")


def validate_step_report(
    report: Dict[str, Any],
    mode: str,
    window_record: Dict[str, Any],
    allow_input: bool,
    require_postcondition: bool,
    min_delta: float,
) -> Dict[str, Any]:
    if report.get("kind") != "mhxy-shikong.bounded-live-step" or report.get("version") != 1:
        raise RuntimeError("bounded live step report has an unexpected schema")
    if report.get("mode") != mode:
        raise RuntimeError("bounded live step mode does not match the request")
    if bool(report.get("allowInput")) != bool(allow_input):
        raise RuntimeError("bounded live step allowInput does not match the request")

    expected = window_record.get("windowIdentity") or {}
    actual = report.get("target") or {}

    def _norm_process_name(value: Any) -> str:
        text = str(value or "").strip()
        if text.lower().endswith(".exe"):
            text = text[:-4]
        return text.casefold()

    for key, expected_value in [
        ("hwnd", expected.get("hwnd")),
        ("pid", expected.get("pid")),
        ("title", expected.get("title")),
        ("processName", expected.get("process")),
        ("clientWidth", expected.get("clientWidth")),
        ("clientHeight", expected.get("clientHeight")),
    ]:
        actual_value = actual.get(key)
        if key == "processName":
            if _norm_process_name(actual_value) != _norm_process_name(expected_value):
                raise RuntimeError("bounded live step target processName does not match window evidence")
            continue
        if actual_value != expected_value:
            raise RuntimeError("bounded live step target {} does not match window evidence".format(key))

    privilege = report.get("privilege")
    if privilege not in INPUT_ELIGIBLE_PRIVILEGES:
        raise RuntimeError("bounded live step privilege is not eligible: {!r}".format(privilege))

    input_sent = bool(report.get("inputSent"))
    if mode == "match_only":
        if input_sent:
            raise RuntimeError("match_only must never report inputSent")
        if report.get("matched") is not True:
            raise RuntimeError("match_only did not match the requested template")
    else:
        if not allow_input:
            raise RuntimeError("input modes require --allow-input")
        if not input_sent:
            raise RuntimeError("input mode did not report inputSent")
        input_record = report.get("input") or {}
        if not isinstance(input_record, dict) or int(input_record.get("sentMessages") or 0) < 1:
            raise RuntimeError("input mode lacks sentMessages proof")
        if require_postcondition:
            delta = report.get("frameDeltaRatio")
            if isinstance(delta, bool) or not isinstance(delta, (int, float)) or not math.isfinite(float(delta)):
                raise RuntimeError("live_outcome requires a finite frameDeltaRatio")
            if float(delta) < min_delta:
                raise RuntimeError(
                    "live_outcome postcondition not observed: frameDeltaRatio={} < {}".format(
                        delta, min_delta
                    )
                )
            if report.get("afterCapture") is None:
                raise RuntimeError("live_outcome requires afterCapture observation")

    if report.get("foregroundUnchanged") is not True:
        raise RuntimeError("foreground HWND changed during bounded live step")
    if report.get("cursorUnchanged") is not True:
        raise RuntimeError("cursor position changed during bounded live step")

    return {
        "targetIdentity": window_record["targetIdentity"],
        "inputSent": input_sent,
        "mode": mode,
        "privilege": privilege,
        "frameDeltaRatio": report.get("frameDeltaRatio"),
        "foregroundUnchanged": True,
        "cursorUnchanged": True,
        "matched": report.get("matched"),
    }

def relposix(path: Path) -> str:
    return str(path.relative_to(progress.ROOT)).replace(chr(92), "/")


def current_process_is_elevated() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run_bounded_live_step(command: List[str], report_path: Path, require_elevated: bool):
    if not require_elevated or current_process_is_elevated():
        return subprocess.run(
            command,
            cwd=str(progress.ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            check=False,
            shell=False,
        )

    bin_path = progress.ROOT / "src-tauri" / "target" / "debug" / "bounded_live_step.exe"
    if not bin_path.is_file():
        build = subprocess.run(
            [
                "cargo",
                "build",
                "--quiet",
                "--locked",
                "--manifest-path",
                str(progress.ROOT / "src-tauri" / "Cargo.toml"),
                "--bin",
                "bounded_live_step",
            ],
            cwd=str(progress.ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
            shell=False,
        )
        if build.returncode != 0:
            raise RuntimeError("failed to build bounded_live_step: {}".format(build.stdout))
    if not bin_path.is_file():
        raise RuntimeError("bounded_live_step.exe missing")
    if "--" not in command:
        raise RuntimeError("bounded live step command missing -- separator")
    step_args = command[command.index("--") + 1 :]
    if report_path.exists():
        report_path.unlink()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    argfile = report_path.parent / "elevated-args.txt"
    argfile.write_text(chr(10).join(str(a) for a in step_args) + chr(10), encoding="utf-8-sig")
    log = report_path.parent / "elevated-run.log"
    launcher = report_path.parent / "elevated-run.ps1"
    nl = chr(10)
    lines = [
        "$ErrorActionPreference = 'Stop'",
        "Set-Location -LiteralPath '" + str(progress.ROOT).replace("'", "''") + "'",
        "$bin = '" + str(bin_path).replace("'", "''") + "'",
        "$argFile = '" + str(argfile).replace("'", "''") + "'",
        "$log = '" + str(log).replace("'", "''") + "'",
        "$stepArgs = Get-Content -LiteralPath $argFile -Encoding utf8",
        "try {",
        "  $p = Start-Process -FilePath $bin -ArgumentList $stepArgs -WorkingDirectory (Get-Location) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput ($log + '.out') -RedirectStandardError ($log + '.err')",
        "  ('exit=' + $p.ExitCode) | Set-Content -LiteralPath $log -Encoding utf8",
        "  exit $p.ExitCode",
        "} catch {",
        "  $_ | Out-String | Set-Content -LiteralPath $log -Encoding utf8",
        "  exit 2",
        "}",
        "",
    ]
    launcher.write_text(nl.join(lines), encoding="utf-8")
    ps_cmd = (
        "Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"
        + str(launcher).replace("'", "''")
        + "') -Verb RunAs -Wait"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_cmd],
        cwd=str(progress.ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=240,
        check=False,
        shell=False,
    )
    if not report_path.is_file():
        detail = completed.stdout or ""
        for extra in [log, Path(str(log) + ".out"), Path(str(log) + ".err")]:
            if extra.exists():
                detail += nl + extra.read_text(encoding="utf-8", errors="replace")
        raise RuntimeError("elevated bounded_live_step did not write report: {}".format(detail))

    class _Done(object):
        def __init__(self, path):
            self.returncode = 0
            self.stdout = STEP_MARKER + Path(path).read_text(encoding="utf-8")

    return _Done(report_path)

def verify_bounded_live_input(
    criterion_id: str,
    category: str,
    mode: str,
    window_evidence_id: str,
    preflight_evidence_id: Optional[str],
    allow_input: bool,
    hotkey: Optional[str],
    template_path: Optional[Path],
    roi: Optional[Tuple[int, int, int, int]],
    threshold: float,
    target_id: Optional[str],
    binding_fingerprint: Optional[str],
    manual_confirmation: Optional[Dict[str, Any]],
    observe_ms: int,
    min_delta: float,
) -> Dict[str, Any]:
    if category not in LIVE_CATEGORIES:
        raise RuntimeError("category must be live_input or live_outcome")
    if mode not in ALLOWED_MODES:
        raise RuntimeError("unsupported mode: {}".format(mode))
    if category == "live_outcome" and mode == "match_only":
        raise RuntimeError("live_outcome cannot use match_only")
    if mode in {"hotkey", "image_click"} and not allow_input:
        raise RuntimeError("hotkey/image_click require --allow-input")
    if mode == "hotkey" and not hotkey:
        raise RuntimeError("hotkey mode requires --hotkey")
    if mode in {"match_only", "image_click"} and (template_path is None or roi is None):
        raise RuntimeError("match_only/image_click require --template and --roi")
    if mode == "image_click":
        if not target_id or not binding_fingerprint or manual_confirmation is None:
            raise RuntimeError(
                "image_click requires --target-id, --binding-fingerprint, and --manual-confirmation-json"
            )
        if manual_confirmation["targetId"] != target_id:
            raise RuntimeError("manual confirmation targetId does not match --target-id")
        if manual_confirmation["bindingFingerprint"] != binding_fingerprint:
            raise RuntimeError("manual confirmation fingerprint does not match --binding-fingerprint")

    with progress.ProgressLock(progress.progress_lock_path()):
        state = progress.load_json(progress.STATE_PATH)
        progress.refresh_state_runtime_fields(state)
        git_binding = current_git_binding(state)
        expected_criterion = criterion_binding(state, criterion_id, category)
        records = progress.load_jsonl(progress.EVIDENCE_PATH)
        window_record = current_window_evidence(state, window_evidence_id, records)
        preflight_record = optional_preflight_evidence(
            state, preflight_evidence_id, records, window_record["targetIdentity"]
        )

    identity = window_record["windowIdentity"]
    elevated_target = identity.get("privilege") == "elevated" or bool(
        (window_record.get("verification") or {}).get("targetElevated")
    )
    report_dir = (
        progress.ROOT
        / "assets"
        / "resource"
        / "ShiKong"
        / "reports"
        / "dev-progress"
        / "bounded-live-{}-{}-{}".format(criterion_id, mode, report_stamp())
    )
    report_dir.mkdir(parents=True, exist_ok=False)
    step_report_path = report_dir / "step-report.json"
    command = build_step_command(
        mode,
        identity,
        allow_input,
        hotkey,
        template_path,
        roi,
        threshold,
        target_id,
        binding_fingerprint,
        manual_confirmation,
        observe_ms,
        step_report_path,
        elevated_target=elevated_target,
    )

    require_elevated = elevated_target or bool(
        (window_record.get("verification") or {}).get("targetElevated")
    )
    completed = run_bounded_live_step(command, step_report_path, require_elevated)
    if completed.returncode != 0:
        raise RuntimeError(
            "bounded live step failed with exit code {}: {}".format(
                completed.returncode, completed.stdout.strip()
            )
        )
    step_report = parse_step_output(completed.stdout, step_report_path)

    with progress.ProgressLock(progress.progress_lock_path()):
        state = progress.load_json(progress.STATE_PATH)
        progress.refresh_state_runtime_fields(state)
        if current_git_binding(state) != git_binding:
            raise RuntimeError("source workspace changed while the bounded live step was running")
        if criterion_binding(state, criterion_id, category) != expected_criterion:
            raise RuntimeError("active criterion changed while the bounded live step was running")
        refreshed_window = current_window_evidence(
            state, window_evidence_id, progress.load_jsonl(progress.EVIDENCE_PATH)
        )
        if refreshed_window.get("targetIdentity") != window_record.get("targetIdentity"):
            raise RuntimeError("window identity changed while the bounded live step was running")
        window_record = refreshed_window

    summary = validate_step_report(
        step_report,
        mode,
        window_record,
        allow_input,
        require_postcondition=(category == "live_outcome"),
        min_delta=min_delta,
    )
    command_text = subprocess.list2cmdline(command)
    verification = {
        "verifier": VERIFIER_NAME,
        "criterionId": criterion_id,
        "category": category,
        "windowEvidenceId": window_evidence_id,
        "preflightEvidenceId": preflight_evidence_id,
        "targetIdentity": window_record["targetIdentity"],
        "windowIdentity": identity,
        "mode": mode,
        "allowInput": allow_input,
        "hotkey": hotkey,
        "templatePath": relposix(template_path) if template_path is not None else None,
        "roi": (
            {"x": roi[0], "y": roi[1], "width": roi[2], "height": roi[3]} if roi is not None else None
        ),
        "threshold": threshold if mode in {"match_only", "image_click"} else None,
        "targetId": target_id,
        "bindingFingerprint": binding_fingerprint,
        "manualConfirmation": manual_confirmation,
        "observeMs": observe_ms,
        "minDelta": min_delta,
        "inputSent": summary["inputSent"],
        "step": step_report,
        "summary": summary,
        "preflight": {
            "evidenceId": preflight_record.get("id") if preflight_record else None,
            "present": preflight_record is not None,
        },
        "observedHead": git_binding["observedHead"],
        "workingTreeFingerprint": git_binding["workingTreeFingerprint"],
        "createdAt": utc_now(),
    }
    verification_path = report_dir / "verification-report.json"
    verification_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + chr(10), encoding="utf-8")

    claim = {
        "live_input": "Bounded home-vitality live input executed with inputSent after elevated gates",
        "live_outcome": "Bounded home-vitality live outcome observed after inputSent",
    }[category]
    evidence_args = argparse.Namespace(
        id=None,
        category=category,
        claim=claim,
        status="passed",
        command=command_text,
        target_identity=window_record["targetIdentity"],
        window_evidence_id=window_evidence_id,
        window_hwnd=identity["hwnd"],
        window_pid=identity["pid"],
        window_title=identity["title"],
        window_process=identity["process"],
        client_width=identity["clientWidth"],
        client_height=identity["clientHeight"],
        privilege=identity["privilege"],
        exit_code=0,
        criterion=[criterion_id],
        artifact=[relposix(verification_path), relposix(step_report_path)],
        input_sent=bool(summary["inputSent"]),
        foreground_unchanged=True,
        cursor_unchanged=True,
        window_identity_verified=True,
        postcondition_observed=bool(category == "live_outcome"),
        capture_method="specialized_verifier",
        runner_profile=None,
        verifier=VERIFIER_NAME,
        verification=verification,
        expected_git_binding=git_binding,
        expected_criterion_binding=expected_criterion,
    )
    evidence_id = progress.record_evidence(evidence_args, allow_passed=True)
    return {
        "evidenceId": evidence_id,
        "targetIdentity": window_record["targetIdentity"],
        "reportPath": str(verification_path),
        "inputSent": summary["inputSent"],
        "mode": mode,
        "category": category,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criterion", required=True)
    parser.add_argument("--category", choices=sorted(LIVE_CATEGORIES), required=True)
    parser.add_argument("--mode", choices=sorted(ALLOWED_MODES), required=True)
    parser.add_argument("--window-evidence-id", required=True)
    parser.add_argument("--preflight-evidence-id")
    parser.add_argument("--allow-input", action="store_true")
    parser.add_argument("--hotkey")
    parser.add_argument("--template")
    parser.add_argument("--roi")
    parser.add_argument("--threshold", type=float, default=0.86)
    parser.add_argument("--target-id")
    parser.add_argument("--binding-fingerprint")
    parser.add_argument("--manual-confirmation-json")
    parser.add_argument("--observe-ms", type=int, default=900)
    parser.add_argument("--min-delta", type=float, default=0.001)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if not 0.0 <= args.threshold <= 1.0:
        raise RuntimeError("--threshold must be within 0..1")
    if not 0 <= args.observe_ms <= 10_000:
        raise RuntimeError("--observe-ms must be within 0..10000")
    if not 0.0 <= args.min_delta <= 1.0:
        raise RuntimeError("--min-delta must be within 0..1")

    template_path = resolve_template_path(args.template) if args.template else None
    roi = parse_roi(args.roi) if args.roi else None
    manual_confirmation = (
        parse_manual_confirmation(args.manual_confirmation_json)
        if args.manual_confirmation_json
        else None
    )
    result = verify_bounded_live_input(
        args.criterion,
        args.category,
        args.mode,
        args.window_evidence_id,
        args.preflight_evidence_id,
        args.allow_input,
        args.hotkey,
        template_path,
        roi,
        args.threshold,
        args.target_id,
        args.binding_fingerprint,
        manual_confirmation,
        args.observe_ms,
        args.min_delta,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["evidenceId"])
        print(result["targetIdentity"])
        print(result["reportPath"])
        print("inputSent={}".format(result["inputSent"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("bounded live input verification failed: {}".format(exc), file=sys.stderr)
        sys.exit(1)
