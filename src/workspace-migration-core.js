export function numericSchemaVersion(value, fallback = 0) {
  const version = Number(value);
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : fallback;
}

export function countAssignmentQueueItems(assignments) {
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) return 0;
  return Object.values(assignments).reduce((count, assignment) => {
    if (!assignment || typeof assignment !== "object") return count;
    if (Array.isArray(assignment.queue)) return count + assignment.queue.length;
    return assignment.workflowId ? count + 1 : count;
  }, 0);
}

function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

function countObjectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

export function workspaceMigrationAudit(sourceValue, normalizedValue, currentSchemaVersion) {
  const source = sourceValue && typeof sourceValue === "object" ? sourceValue : {};
  const normalized = normalizedValue && typeof normalizedValue === "object" ? normalizedValue : {};
  const current = numericSchemaVersion(currentSchemaVersion, 0);
  const sourceSchemaVersion = numericSchemaVersion(source.schemaVersion, 0);
  const normalizedSchemaVersion = numericSchemaVersion(normalized.schemaVersion, current);

  const sourceWorkflowCount = countItems(source.workflows);
  const normalizedWorkflowCount = countItems(normalized.workflows);
  const legacyAssetCount = countItems(source.assets);
  const sourceTargetCount = countItems(source.targets);
  const normalizedTargetCount = countItems(normalized.targets);
  const sourceRunHistoryCount = countItems(source.runHistory);
  const normalizedRunHistoryCount = countItems(normalized.runHistory);
  const sourceQueueItemCount = countAssignmentQueueItems(source.assignments);
  const normalizedQueueItemCount = countAssignmentQueueItems(normalized.assignments);
  const sourceAssignmentCount = countObjectKeys(source.assignments);
  const normalizedAssignmentCount = countObjectKeys(normalized.assignments);

  const upgraded = sourceSchemaVersion > 0 && sourceSchemaVersion < current;
  const futureSchema = sourceSchemaVersion > current;
  const legacyAssetsMigrated = legacyAssetCount > 0;
  const generatedTargets = sourceTargetCount === 0 && legacyAssetCount === 0 && normalizedTargetCount > 0;
  const runHistoryTrimmed = Math.max(0, sourceRunHistoryCount - normalizedRunHistoryCount);
  const droppedQueueItems = Math.max(0, sourceQueueItemCount - normalizedQueueItemCount);
  const droppedAssignments = Math.max(0, sourceAssignmentCount - normalizedAssignmentCount);
  const schemaChanged = !futureSchema && normalizedSchemaVersion !== sourceSchemaVersion;
  const shouldSave =
    !futureSchema &&
    (upgraded ||
      legacyAssetsMigrated ||
      generatedTargets ||
      runHistoryTrimmed > 0 ||
      droppedQueueItems > 0 ||
      droppedAssignments > 0 ||
      schemaChanged);

  const actions = [];
  const warnings = [];

  if (!sourceValue || typeof sourceValue !== "object") {
    warnings.push("source_not_object");
  }
  if (futureSchema) {
    warnings.push("future_schema");
  }
  if (upgraded || schemaChanged) {
    actions.push("schema_normalized");
  }
  if (legacyAssetsMigrated) {
    actions.push("legacy_assets_migrated");
  }
  if (generatedTargets) {
    actions.push("target_catalog_generated");
  }
  if (runHistoryTrimmed > 0) {
    actions.push("run_history_trimmed");
  }
  if (droppedQueueItems > 0 || droppedAssignments > 0) {
    actions.push("invalid_assignments_dropped");
  }

  return {
    sourceSchemaVersion,
    normalizedSchemaVersion,
    currentSchemaVersion: current,
    upgraded,
    futureSchema,
    shouldSave,
    actions,
    warnings,
    counts: {
      sourceWorkflows: sourceWorkflowCount,
      normalizedWorkflows: normalizedWorkflowCount,
      legacyAssets: legacyAssetCount,
      sourceTargets: sourceTargetCount,
      normalizedTargets: normalizedTargetCount,
      sourceAssignments: sourceAssignmentCount,
      normalizedAssignments: normalizedAssignmentCount,
      sourceQueueItems: sourceQueueItemCount,
      normalizedQueueItems: normalizedQueueItemCount,
      droppedQueueItems,
      droppedAssignments,
      sourceRunHistory: sourceRunHistoryCount,
      normalizedRunHistory: normalizedRunHistoryCount,
      runHistoryTrimmed,
    },
  };
}

export function workspaceMigrationSummaryText(audit, options = {}) {
  if (!audit) return "迁移审计等待载入";
  const parts = [];
  const sourceVersion = audit.sourceSchemaVersion || "unknown";
  parts.push(`schema ${sourceVersion} -> ${audit.normalizedSchemaVersion}`);
  if (audit.upgraded) parts.push("已升级");
  if (audit.futureSchema) parts.push("未来版本，需谨慎");
  if (audit.counts.legacyAssets) parts.push(`迁移旧 assets ${audit.counts.legacyAssets}`);
  if (audit.counts.runHistoryTrimmed) parts.push(`裁剪运行记录 ${audit.counts.runHistoryTrimmed}`);
  if (audit.counts.droppedQueueItems) parts.push(`丢弃失效队列项 ${audit.counts.droppedQueueItems}`);
  if (audit.counts.droppedAssignments) parts.push(`丢弃空窗口队列 ${audit.counts.droppedAssignments}`);
  if (audit.counts.normalizedTargets) parts.push(`目标 ${audit.counts.normalizedTargets}`);
  if (audit.counts.normalizedWorkflows) parts.push(`任务 ${audit.counts.normalizedWorkflows}`);
  if (options.backupPath) parts.push(`备份 ${options.backupPath}`);
  return parts.join(" · ");
}
