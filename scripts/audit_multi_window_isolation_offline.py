from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
core = (ROOT / "src" / "multi-window-isolation-core.js").read_text(encoding="utf-8")
main = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
assert "analyzeWindowEventTimeline" in core
assert "assessDualQueueIsolation" in core
assert "multi-window-isolation-core.js" in main
print("audit_multi_window_isolation_offline: ok")
