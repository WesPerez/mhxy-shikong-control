from pathlib import Path
import json
ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / "fixtures" / "regression" / "catalog.json").read_text(encoding="utf-8"))
core = (ROOT / "src" / "regression-suite-core.js").read_text(encoding="utf-8")
assert "validateRegressionCatalog" in core
validated = [t for t in catalog["tasks"] if t.get("status") == "validated"]
assert len(validated) >= 5
assert len(catalog.get("failureMatrix") or []) >= 9
for t in validated:
    assert (ROOT / "fixtures" / "regression" / f"{t['id']}.success.json").is_file()
    assert (ROOT / "fixtures" / "regression" / f"{t['id']}.failure.json").is_file()
print("audit_regression_suite_offline: ok")
