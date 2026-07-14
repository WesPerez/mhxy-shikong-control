from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
core=(ROOT/"src"/"team-observe-core.js").read_text(encoding="utf-8")
main=(ROOT/"src"/"main.js").read_text(encoding="utf-8")
assert "TEAM_OBSERVE_BLUEPRINT" in core and "assessTeamObserveReadiness" in core
assert core.count("{ type:") >= 10
assert "team-observe-core.js" in main
print("audit_team_observe_offline: ok")
