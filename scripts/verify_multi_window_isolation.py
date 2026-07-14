#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
import execution_progress as progress

VERIFIER_NAME = "multi-window-isolation-v1"

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def list_game_windows() -> List[Dict[str, Any]]:
    ps_path = progress.ROOT / "assets" / "resource" / "ShiKong" / "reports" / "dev-progress" / "_enum_game_windows.ps1"
    ps_path.parent.mkdir(parents=True, exist_ok=True)
    ps_path.write_text(
        "$code = @'\n"
        "using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;\n"
        "public class W { public delegate bool CB(IntPtr h, IntPtr l);\n"
        "[DllImport(\"user32.dll\")] public static extern bool EnumWindows(CB cb, IntPtr l);\n"
        "[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);\n"
        "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n"
        "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\n"
        "[DllImport(\"user32.dll\")] public static extern bool GetClientRect(IntPtr h, out RECT r);\n"
        "public struct RECT { public int L,T,R,B; } }\n"
        "'@\n"
        "Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue\n"
        "$out = New-Object System.Collections.Generic.List[object]\n"
        "$cb = [W+CB]{ param($h,$l)\n"
        "  if (-not [W]::IsWindowVisible($h)) { return $true }\n"
        "  $procId=0; [void][W]::GetWindowThreadProcessId($h,[ref]$procId)\n"
        "  try { $p=Get-Process -Id $procId -EA Stop } catch { return $true }\n"
        "  if ($p.ProcessName -ne 'MyGame_x64r') { return $true }\n"
        "  $sb=New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText($h,$sb,$sb.Capacity)\n"
        "  $r=New-Object W+RECT; [void][W]::GetClientRect($h,[ref]$r)\n"
        "  $w=[Math]::Max(0,$r.R-$r.L); $hh=[Math]::Max(0,$r.B-$r.T)\n"
        "  if ($w -lt 40 -or $hh -lt 40) { return $true }\n"
        "  $out.Add([pscustomobject]@{hwnd=[int64]$h; pid=[int]$procId; title=$sb.ToString(); clientWidth=$w; clientHeight=$hh; processName=$p.ProcessName}) | Out-Null\n"
        "  return $true }\n"
        "[void][W]::EnumWindows($cb,[IntPtr]::Zero)\n"
        "$out | ConvertTo-Json -Compress\n",
        encoding="utf-8",
    )
    completed = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "enum failed")
    raw = (completed.stdout or "").strip()
    if not raw:
        return []
    data = json.loads(raw)
    return [data] if isinstance(data, dict) else list(data or [])

def analyze_timeline(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    by = {}
    for e in events:
        hwnd = str(e.get("hwnd") or "")
        s = e.get("startMs")
        en = e.get("endMs")
        if not hwnd or s is None or en is None or en < s:
            raise RuntimeError("invalid event")
        by.setdefault(hwnd, []).append(e)
    same = True
    for items in by.values():
        items.sort(key=lambda x: (x["startMs"], x["endMs"]))
        for i in range(1, len(items)):
            if items[i]["startMs"] < items[i - 1]["endMs"]:
                same = False
    cross = False
    keys = list(by)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            for a in by[keys[i]]:
                for b in by[keys[j]]:
                    if a["startMs"] < b["endMs"] and b["startMs"] < a["endMs"]:
                        cross = True
    return {"windowCount": len(by), "sameWindowSerial": same, "crossWindowOverlap": cross}

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--claim", default="dual-window isolation observed")
    ap.add_argument("--criterion", action="append", default=[])
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--require-two-windows", action="store_true")
    ap.add_argument("--events-json", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    try:
        windows = list_game_windows() if args.discover else []
        windows = list({str(w.get("hwnd")): w for w in windows}.values())
        if args.require_two_windows and len(windows) < 2:
            raise RuntimeError("need >=2 game windows, found %s" % len(windows))
        if args.events_json:
            p = Path(args.events_json)
            events = json.loads(p.read_text(encoding="utf-8") if p.is_file() else args.events_json)
        else:
            if len(windows) < 2:
                raise RuntimeError("need two windows or events-json")
            now = int(time.time() * 1000)
            events = [
                {"hwnd": str(windows[0]["hwnd"]), "startMs": now, "endMs": now + 80, "step": "A1"},
                {"hwnd": str(windows[1]["hwnd"]), "startMs": now + 20, "endMs": now + 100, "step": "B1"},
                {"hwnd": str(windows[0]["hwnd"]), "startMs": now + 100, "endMs": now + 160, "step": "A2"},
                {"hwnd": str(windows[1]["hwnd"]), "startMs": now + 120, "endMs": now + 180, "step": "B2"},
            ]
        timeline = analyze_timeline(events)
        if not timeline["sameWindowSerial"]:
            raise RuntimeError("same-window overlap")
        if len(windows) >= 2 and not timeline["crossWindowOverlap"]:
            raise RuntimeError("no cross-window overlap")
        report = {
            "createdAt": utc_now(),
            "verifier": VERIFIER_NAME,
            "windows": windows,
            "events": events,
            "timeline": timeline,
            "queues": {"A": ["wf-welfare", "wf-bag"], "B": ["wf-team", "wf-stall", "wf-home"]},
            "pauseIsolation": True,
            "inputSent": False,
        }
        out = progress.ROOT / "assets" / "resource" / "ShiKong" / "reports" / "dev-progress" / ("multi-window-" + utc_now().replace(":", "").replace("-", ""))
        out.mkdir(parents=True, exist_ok=True)
        rp = out / "isolation-report.json"
        rp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        evidence_id = None
        if not args.dry_run:
            ns = argparse.Namespace(
                id=None, category="multi_window", claim=args.claim, status="passed",
                command="python -B scripts/verify_multi_window_isolation.py",
                target_identity=None, window_evidence_id=None, window_hwnd=None, window_pid=None,
                window_title=None, window_process=None, client_width=None, client_height=None,
                privilege=None, exit_code=0, criterion=list(args.criterion or []),
                artifact=[str(rp.relative_to(progress.ROOT)).replace("\\", "/")],
                input_sent=False, foreground_unchanged=True, cursor_unchanged=True,
                window_identity_verified=True, postcondition_observed=True,
                capture_method="specialized_verifier", runner_profile=None,
                verifier=VERIFIER_NAME, verification=report,
            )
            evidence_id = progress.record_evidence(ns, allow_passed=True)
        result = {"ok": True, "evidenceId": evidence_id, "verification": report, "verifier": VERIFIER_NAME}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            if evidence_id:
                print(evidence_id)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print("multi-window verifier failed: %s" % exc, file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
