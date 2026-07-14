from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
core=(ROOT/"src"/"stall-search-core.js").read_text(encoding="utf-8")
main=(ROOT/"src"/"main.js").read_text(encoding="utf-8")
assert "STALL_SEARCH_BLUEPRINT" in core and "assessStallSearchReadiness" in core
assert core.count("{ type:") >= 10
assert "stall-search-core.js" in main
print("audit_stall_search_offline: ok")
