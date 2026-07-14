/** Offline regression suite and failure-matrix helpers. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.resolve(HERE, "../fixtures/regression/catalog.json");

export function loadRegressionCatalog(catalogPath = DEFAULT_CATALOG) {
  const raw = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(raw);
}

export function validateRegressionCatalog(catalog) {
  const tasks = Array.isArray(catalog?.tasks) ? catalog.tasks : [];
  const matrix = Array.isArray(catalog?.failureMatrix) ? catalog.failureMatrix : [];
  const gaps = [];
  const validated = tasks.filter((t) => t.status === "validated");
  if (validated.length < 5) gaps.push({ code: "validated_lt_5", count: validated.length });
  for (const t of validated) {
    if ((t.minSteps || 0) < 10) gaps.push({ code: "validated_steps_lt_10", id: t.id });
    if (!t.liveEvidence) gaps.push({ code: "validated_missing_live", id: t.id });
  }
  for (const t of tasks) {
    if (!["validated", "blueprint", "needs_capture", "unsupported"].includes(t.status)) {
      gaps.push({ code: "invalid_status", id: t.id, status: t.status });
    }
  }
  const requiredFailures = [
    "missing_asset",
    "missing_coordinate",
    "ocr_mismatch",
    "image_not_found",
    "privilege_insufficient",
    "window_disappeared",
    "capture_unreliable",
    "task_interrupted",
    "restart_recovery_config_only",
  ];
  const ids = new Set(matrix.map((m) => m.id));
  for (const id of requiredFailures) {
    if (!ids.has(id)) gaps.push({ code: "missing_failure_case", id });
  }
  return { ok: gaps.length === 0, validatedCount: validated.length, taskCount: tasks.length, matrixCount: matrix.length, gaps };
}

export function assertFixturePairExists(taskId, fixturesDir) {
  const success = path.join(fixturesDir, taskId + ".success.json");
  const failure = path.join(fixturesDir, taskId + ".failure.json");
  return { success: fs.existsSync(success), failure: fs.existsSync(failure), successPath: success, failurePath: failure };
}
