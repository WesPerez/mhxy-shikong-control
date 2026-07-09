#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  countAssignmentQueueItems,
  numericSchemaVersion,
  workspaceMigrationAudit,
  workspaceMigrationSummaryText,
} from "../src/workspace-migration-core.js";

function testNumericSchemaVersion() {
  assert.equal(numericSchemaVersion("8"), 8);
  assert.equal(numericSchemaVersion(8.9), 8);
  assert.equal(numericSchemaVersion("bad", 7), 7);
  assert.equal(numericSchemaVersion(-1, 7), 7);
}

function testAssignmentQueueCountingSupportsLegacyShape() {
  assert.equal(
    countAssignmentQueueItems({
      "100": { queue: [{ workflowId: "a" }, { workflowId: "b" }] },
      "200": { workflowId: "legacy" },
      "300": { queue: [] },
    }),
    3,
  );
}

function testMigrationAuditFlagsLegacyWorkspaceNormalization() {
  const source = {
    schemaVersion: 7,
    workflows: [{ id: "wf.keep" }],
    assets: [{ id: "button.old" }],
    targets: [{ id: "button.existing" }],
    assignments: {
      "100": { queue: [{ workflowId: "wf.keep" }, { workflowId: "wf.missing" }] },
      "200": { workflowId: "wf.missing" },
    },
    runHistory: Array.from({ length: 90 }, (_, index) => ({ id: `run.${index}` })),
  };
  const normalized = {
    schemaVersion: 8,
    workflows: [{ id: "wf.keep" }],
    targets: [{ id: "button.old" }, { id: "button.existing" }],
    assignments: {
      "100": { queue: [{ workflowId: "wf.keep" }] },
    },
    runHistory: source.runHistory.slice(0, 80),
  };

  const audit = workspaceMigrationAudit(source, normalized, 8);

  assert.equal(audit.upgraded, true);
  assert.equal(audit.shouldSave, true);
  assert.equal(audit.counts.legacyAssets, 1);
  assert.equal(audit.counts.droppedQueueItems, 2);
  assert.equal(audit.counts.droppedAssignments, 1);
  assert.equal(audit.counts.runHistoryTrimmed, 10);
  assert.deepEqual(audit.actions, [
    "schema_normalized",
    "legacy_assets_migrated",
    "run_history_trimmed",
    "invalid_assignments_dropped",
  ]);
}

function testMigrationAuditRecognizesStableWorkspace() {
  const source = {
    schemaVersion: 8,
    workflows: [{ id: "wf.keep" }],
    targets: [{ id: "button.existing" }],
    assignments: {
      "100": { queue: [{ workflowId: "wf.keep" }] },
    },
    runHistory: [{ id: "run.1" }],
  };
  const audit = workspaceMigrationAudit(source, source, 8);

  assert.equal(audit.shouldSave, false);
  assert.equal(audit.upgraded, false);
  assert.equal(audit.futureSchema, false);
  assert.deepEqual(audit.actions, []);
}

function testMigrationAuditWarnsOnFutureSchema() {
  const audit = workspaceMigrationAudit({ schemaVersion: 99 }, { schemaVersion: 8 }, 8);

  assert.equal(audit.futureSchema, true);
  assert.equal(audit.shouldSave, false);
  assert.ok(audit.warnings.includes("future_schema"));
}

function testMigrationSummaryMentionsUserVisibleEvidence() {
  const audit = workspaceMigrationAudit(
    { schemaVersion: 7, assets: [{ id: "a" }], runHistory: [{}, {}] },
    { schemaVersion: 8, targets: [{ id: "a" }], runHistory: [{}] },
    8,
  );
  const summary = workspaceMigrationSummaryText(audit, { backupPath: "workspace.json.bak" });

  assert.match(summary, /schema 7 -> 8/);
  assert.match(summary, /迁移旧 assets 1/);
  assert.match(summary, /裁剪运行记录 1/);
  assert.match(summary, /备份 workspace\.json\.bak/);
}

const tests = [
  testNumericSchemaVersion,
  testAssignmentQueueCountingSupportsLegacyShape,
  testMigrationAuditFlagsLegacyWorkspaceNormalization,
  testMigrationAuditRecognizesStableWorkspace,
  testMigrationAuditWarnsOnFutureSchema,
  testMigrationSummaryMentionsUserVisibleEvidence,
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}

console.log(`${tests.length} workspace migration tests passed`);
