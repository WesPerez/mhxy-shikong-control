import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegressionCatalog, validateRegressionCatalog, assertFixturePairExists } from "../src/regression-suite-core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadRegressionCatalog(path.join(root, "fixtures/regression/catalog.json"));
const result = validateRegressionCatalog(catalog);
assert.equal(result.ok, true, JSON.stringify(result.gaps));
assert.ok(result.validatedCount >= 5);
for (const t of catalog.tasks.filter((x) => x.status === "validated")) {
  const pair = assertFixturePairExists(t.id, path.join(root, "fixtures/regression"));
  assert.equal(pair.success, true);
  assert.equal(pair.failure, true);
}
console.log("regression-suite-core: ok");
