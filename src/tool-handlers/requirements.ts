import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow, RequirementRow } from "../types.js";
import type { ChangeMode } from "../development-warnings.js";
import { CompleteRequirementArgsSchema, GetPendingChangesArgsSchema, MAX_PENDING_LIMIT, PreflightChangeScopeArgsSchema, StartRequirementArgsSchema, SyncChangeIntentArgsSchema } from "../tool-schemas.js";
import { buildDevelopmentWarnings, buildRequirementMappingWarnings, buildRequirementScopeContract, buildRequirementStartWarnings, buildScopeDriftWarnings, getRequirementItems, getRequirementScopeContract, isDevelopmentWarningBlockingForChangeMode, mergeScopeContracts, normalizeRequirementItems } from "../development-warnings.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer, indexFile } from "../file-indexing.js";
import { buildFixPatternContent, buildFixPatternMetadata, buildFixPatternQualitySignals, collectRelevantFixPatterns, normalizeFixPattern } from "../fix-patterns.js";
import { completeAllActiveRequirementMemoryItems, completeRequirementMemoryItemsByReqId } from "../memory-mutations.js";
import { makePreviewText, parseMetadataJson } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { compactPreflightChangeScopeText, safeJson, toolJson } from "../tool-output.js";
import { normalizeRequirementGoalIdentity, sameRequirement } from "../context-governance.js";
import { DEVELOPMENT_HUGE_FILE_LINES } from "../config.js";
import { hashFileContentStreaming } from "../large-file-split.js";

let sessionActiveRequirement: { project_root: string; id: number } | null = null;

const UNFINISHED_SPLIT_PLAN_STATUSES = new Set(["planned", "in_progress", "partial", "needs_refinement"]);

function fileReachesLineThreshold(absPath: string, threshold: number): boolean {
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let lines = 0;
    let bytesRead = 0;
    let sawBytes = false;
    let lastByte = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      sawBytes = true;
      lastByte = buffer[bytesRead - 1];
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) lines += 1;
      }
      if (lines >= threshold) return true;
    } while (bytesRead > 0);
    return lines + (sawBytes && lastByte !== 10 ? 1 : 0) >= threshold;
  } finally {
    fs.closeSync(fd);
  }
}

function hasUnfinishedLargeFileSplitPlan(
  context: ToolHandlerContext,
  reqId: number,
  filePath: string,
): boolean {
  const rows = context.getDb().prepare(
    `SELECT metadata_json
       FROM memory_items
      WHERE kind = 'large_file_split_plan' AND req_id = ? AND file_path = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 20`,
  ).all(reqId, filePath) as Array<{ metadata_json: string | null }>;
  return rows.some((row) => UNFINISHED_SPLIT_PLAN_STATUSES.has(String(parseMetadataJson(row.metadata_json).status)));
}

function resolveActiveRequirement(
  context: ToolHandlerContext,
  args: { req_id?: number; goal_key?: string },
): { requirement: RequirementRow | undefined; ambiguous: boolean; active_count: number } {
  const {
    getActiveRequirementByIdStmt,
    getActiveRequirementByGoalKeyStmt,
    listActiveRequirementsStmt,
  } = context.getStatements();
  if (args.req_id) {
    return {
      requirement: getActiveRequirementByIdStmt.get(args.req_id) as RequirementRow | undefined,
      ambiguous: false,
      active_count: 1,
    };
  }
  if (args.goal_key?.trim()) {
    return {
      requirement: getActiveRequirementByGoalKeyStmt.get(args.goal_key.trim()) as RequirementRow | undefined,
      ambiguous: false,
      active_count: 1,
    };
  }
  if (sessionActiveRequirement && sessionActiveRequirement.project_root === context.getProjectRoot()) {
    const sessionRequirement = getActiveRequirementByIdStmt.get(sessionActiveRequirement.id) as RequirementRow | undefined;
    if (sessionRequirement) {
      return { requirement: sessionRequirement, ambiguous: false, active_count: 1 };
    }
    if (sessionActiveRequirement?.project_root === context.getProjectRoot()) sessionActiveRequirement = null;
  }
  const active = listActiveRequirementsStmt.all(2) as RequirementRow[];
  return {
    requirement: active.length === 1 ? active[0] : undefined,
    ambiguous: active.length > 1,
    active_count: active.length,
  };
}

async function validateLargeFileSplitPlans(
  context: ToolHandlerContext,
  args: { split_plan_id?: number; split_plan_ids?: number[] },
  requirement: RequirementRow | undefined,
  hugeFiles: string[],
): Promise<{
  valid: boolean;
  required_files: string[];
  valid_plan_ids: number[];
  invalid: Array<{ plan_id: number; reason: string }>;
  missing_files: string[];
}> {
  const normalizeToDbPath = context.normalizeToDbPath;
  const requiredFiles = [...new Set(hugeFiles.map(normalizeToDbPath))];
  const ids = [...new Set([...(args.split_plan_ids ?? []), ...(args.split_plan_id ? [args.split_plan_id] : [])])];
  const validByFile = new Map<string, number>();
  const invalid: Array<{ plan_id: number; reason: string }> = [];
  const currentHashes = new Map<string, string>();
  for (const planId of ids) {
    const row = context.getStatements().getMemoryItemByIdStmt.get(planId) as MemoryItemRow | undefined;
    if (!row || row.kind !== "large_file_split_plan") {
      invalid.push({ plan_id: planId, reason: "not_a_large_file_split_plan" });
      continue;
    }
    const metadata = parseMetadataJson(row.metadata_json);
    const legacyPlan = metadata.plan && typeof metadata.plan === "object" && !Array.isArray(metadata.plan)
      ? metadata.plan as Record<string, unknown>
      : {};
    const legacyCoverage = legacyPlan.coverage && typeof legacyPlan.coverage === "object" && !Array.isArray(legacyPlan.coverage)
      ? legacyPlan.coverage as Record<string, unknown>
      : {};
    const legacyModuleConstraints = legacyPlan.module_constraints && typeof legacyPlan.module_constraints === "object" && !Array.isArray(legacyPlan.module_constraints)
      ? legacyPlan.module_constraints as Record<string, unknown>
      : {};
    const file = typeof metadata.file === "string" ? normalizeToDbPath(metadata.file) : "";
    const status = typeof metadata.status === "string" ? metadata.status : "";
    const expectedHash = typeof metadata.current_state_hash === "string"
      ? metadata.current_state_hash
      : typeof metadata.source_state_hash === "string"
        ? metadata.source_state_hash
        : null;
    let currentHash: string | null = null;
    if (file) {
      currentHash = currentHashes.get(file) ?? null;
      if (!currentHash) {
        const absPath = path.join(context.getProjectRoot(), file);
        try {
          currentHash = fs.statSync(absPath).isFile()
            ? await hashFileContentStreaming(absPath)
            : context.sha256Hex("missing");
        } catch {
          currentHash = context.sha256Hex("missing");
        }
        currentHashes.set(file, currentHash);
      }
    }
    let reason = "";
    if (!requirement || row.req_id !== requirement.id) reason = "requirement_mismatch";
    else if (!file || !requiredFiles.includes(file)) reason = "file_mismatch";
    else if (!["planned", "in_progress", "partial"].includes(status)) reason = `invalid_status:${status || "missing"}`;
    else if ((metadata.plan_ok ?? legacyPlan.ok) !== true) reason = "plan_requires_refinement";
    else if ((metadata.coverage_complete ?? legacyCoverage.complete) !== true) reason = "incomplete_declaration_coverage";
    else if ((metadata.module_constraints_satisfied ?? legacyModuleConstraints.satisfied ?? false) !== true) reason = "oversized_target_module";
    else if (!expectedHash || expectedHash !== currentHash) reason = "source_state_changed_since_plan";
    if (reason) {
      invalid.push({ plan_id: planId, reason });
      continue;
    }
    validByFile.set(file, planId);
  }
  const missingFiles = requiredFiles.filter((file) => !validByFile.has(file));
  return {
    valid: requiredFiles.length > 0 && missingFiles.length === 0,
    required_files: requiredFiles,
    valid_plan_ids: [...validByFile.values()],
    invalid,
    missing_files: missingFiles,
  };
}
export async function handleStartRequirement(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const sha256Hex = context.sha256Hex;
  const {
    insertRequirementStmt,
    insertMemoryItemStmt,
    getActiveRequirementByGoalKeyStmt,
    listActiveRequirementsStmt,
    getRequirementMemoryItemIdStmt,
  } = context.getStatements();

  const args = StartRequirementArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const scope_contract = buildRequirementScopeContract({
    title: args.title,
    background: args.background,
    scope_allow: args.scope_allow,
    scope_deny: args.scope_deny,
    allowed_paths: args.allowed_paths,
    denied_paths: args.denied_paths,
  });
  const requirement_items = normalizeRequirementItems(args.requirement_items);
  const development_warnings = buildRequirementStartWarnings({
    title: args.title,
    background: args.background,
    close_previous: args.close_previous,
  });

  const explicitGoalKey = args.goal_key?.trim() ?? "";
  const goalKey = explicitGoalKey ||
    `auto:${sha256Hex(normalizeRequirementGoalIdentity(args.title, args.background)).slice(0, 24)}`;
  const activeByGoalKey = getActiveRequirementByGoalKeyStmt.get(goalKey) as RequirementRow | undefined;
  const activeCandidates = listActiveRequirementsStmt.all(50) as RequirementRow[];
  const active = activeByGoalKey ?? (!explicitGoalKey
    ? activeCandidates.find((candidate) => sameRequirement(candidate, { ...args, goal_key: goalKey }))
    : undefined);
  if (args.reuse_active && active && sameRequirement(active, { ...args, goal_key: goalKey })) {
    sessionActiveRequirement = { project_root: context.getProjectRoot(), id: active.id };
    const memoryId = (getRequirementMemoryItemIdStmt.get(active.id) as { id: number } | undefined)?.id ?? null;
    const activeScopeContract = getRequirementScopeContract(active.id);
    const activeRequirementItems = getRequirementItems(active.id);
    logActivity("start_requirement", {
      req_id: active.id,
      title: active.title,
      reused_active: true,
    });
    return {
      content: [
        {
          type: "text",
          text: toolJson({
            ok: true,
            requirement: { id: active.id, title: active.title },
            goal_key: active.goal_key ?? goalKey,
            memory_item: { id: memoryId },
            reused: true,
            closed_previous: false,
            scope_contract: activeScopeContract,
            requirement_items: activeRequirementItems,
            development_warnings: [],
          }),
        },
      ],
    };
  }

  let closedPrevious = false;
  const previousRequirementId = args.previous_req_id ??
    (sessionActiveRequirement?.project_root === context.getProjectRoot() ? sessionActiveRequirement.id : null);
  if (args.close_previous && previousRequirementId) {
    try {
      completeRequirementMemoryItemsByReqId(previousRequirementId);
      closedPrevious = true;
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: toolJson({ ok: false, error: `Failed to close previous requirement atomically: ${String(err)}` }) }],
      };
    }
  }

  let id: number;
  try {
    const info = insertRequirementStmt.run(args.title, args.background || null, goalKey);
    id = Number(info.lastInsertRowid);
  } catch (err) {
    const raced = getActiveRequirementByGoalKeyStmt.get(goalKey) as RequirementRow | undefined;
    if (!raced) throw err;
    sessionActiveRequirement = { project_root: context.getProjectRoot(), id: raced.id };
    return {
      content: [{
        type: "text",
        text: toolJson({
          ok: true,
          requirement: { id: raced.id, title: raced.title },
          goal_key: goalKey,
          reused: true,
          reuse_reason: "concurrent_goal_key_insert",
          closed_previous: closedPrevious,
        }),
      }],
    };
  }

  const background = args.background?.trim() ?? "";
  const content = background ? `${args.title}\n\n${background}` : args.title;
  const memoryInfo = insertMemoryItemStmt.run(
    "requirement",
    args.title,
    content,
    null,
    null,
    null,
    id,
    safeJson({ status: "active", goal_key: goalKey, scope_contract, requirement_items }),
    sha256Hex(content),
  );
  const memory_id = Number(memoryInfo.lastInsertRowid);
  sessionActiveRequirement = { project_root: context.getProjectRoot(), id };

  logActivity("start_requirement", {
    req_id: id,
    title: args.title,
    closed_previous: args.close_previous,
    scope_contract,
    requirement_items,
    development_warnings: development_warnings.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          requirement: { id, title: args.title },
          goal_key: goalKey,
          memory_item: { id: memory_id },
          closed_previous: closedPrevious,
          close_previous_ignored: false,
          scope_contract,
          requirement_items,
          development_warnings,
        }),
      },
    ],
  };
}
export async function handlePreflightChangeScope(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const normalizeToDbPath = context.normalizeToDbPath;
  const args = PreflightChangeScopeArgsSchema.parse(rawArgs);
  const changeMode = args.change_mode as ChangeMode;
  flushPendingChangeBuffer();
  const files = (args.files ?? args.planned_files ?? []).filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const resolution = resolveActiveRequirement(context, args);
  const active = resolution.requirement;
  const explicitContract = buildRequirementScopeContract({
    title: active?.title ?? "",
    background: active?.context_data ?? "",
    scope_allow: args.scope_allow,
    scope_deny: args.scope_deny,
    allowed_paths: args.allowed_paths,
    denied_paths: args.denied_paths,
  });
  const explicitRequirementItems = normalizeRequirementItems(args.requirement_items);
  const requirementItems = explicitRequirementItems.length
    ? explicitRequirementItems
    : active
      ? getRequirementItems(active.id)
      : [];
  const fileInputs = files.map((file_path) => ({ file_path }));
  const development_warnings = [
    ...buildDevelopmentWarnings(fileInputs, { includeUnspecified: fileInputs.length === 0 }),
    ...buildScopeDriftWarnings({
      requirement: active,
      contract: explicitContract,
      intent: args.intent,
      files: fileInputs,
      includeMissingContractHint: true,
    }),
    ...buildRequirementMappingWarnings({
      requirement: active,
      requirement_items: requirementItems,
      planned_changes: args.planned_changes,
      files: fileInputs,
      change_mode: changeMode,
    }),
  ];
  const scope_contract = mergeScopeContracts(
    active ? getRequirementScopeContract(active.id) : null,
    explicitContract,
  );

  logActivity("preflight_change_scope", {
    req_id: active?.id ?? null,
    intent_preview: makePreviewText(args.intent, 200),
    change_mode: changeMode,
    files: files.slice(0, 25),
    files_total: files.length,
    development_warnings: development_warnings.length,
  });

  const hasTargetFiles = fileInputs.length > 0;
  const hugeWarnings = development_warnings.filter((w) => w.code === "huge_file_modularization_required");
  const hasHugeFile = hugeWarnings.length > 0;
  const splitPlanValidation = await validateLargeFileSplitPlans(
    context,
    args,
    active,
    hugeWarnings.flatMap((warning) => warning.files ?? []),
  );
  const deferReason = args.defer_split_reason?.trim() ?? "";
  const minimalBugfixAllowed = changeMode === "bugfix" &&
    args.adds_responsibility === false &&
    deferReason.length > 0;
  const emergencyHotfixAllowed = changeMode === "emergency_hotfix" && deferReason.length > 0;
  const mechanicalPlanAllowed = changeMode === "mechanical_modularization" && splitPlanValidation.valid;
  const hugeGateBlocked = hasHugeFile && !minimalBugfixAllowed && !emergencyHotfixAllowed && !mechanicalPlanAllowed;
  const blockingWarnings = development_warnings.filter((warning) =>
    warning.code !== "huge_file_modularization_required" &&
    isDevelopmentWarningBlockingForChangeMode(warning, changeMode),
  );
  const hasBlockingWarnings = blockingWarnings.length > 0 || hugeGateBlocked;
  const hasActiveRequirement = !!active;
  const safeToEdit = hasActiveRequirement && hasTargetFiles && !hasBlockingWarnings;
  const normalizedFiles = files.map(normalizeToDbPath);
  const relevantFixPatterns = collectRelevantFixPatterns(context, {
    intent: args.intent,
    files: normalizedFiles,
    planned_changes: args.planned_changes,
    requirement: active ?? null,
    limit: 3,
  });
  const quality_signals = buildFixPatternQualitySignals(relevantFixPatterns);
  const recommendedAction = resolution.ambiguous
    ? "Multiple active requirements exist. Pass req_id or goal_key so this preflight cannot attach to another task."
    : !hasActiveRequirement
    ? "Start or resume the current code-change requirement before editing, or pass its req_id/goal_key."
    : !hasTargetFiles
    ? "Identify the intended target files/modules and rerun preflight_change_scope before editing."
    : hasHugeFile && changeMode === "mechanical_modularization" && !splitPlanValidation.valid
      ? "Mechanical modularization requires a valid split_plan_id for every huge target file, with complete declaration coverage and an unchanged source state."
      : hasHugeFile && changeMode === "mechanical_modularization" && safeToEdit
      ? "Proceed with the persisted split plan, move whole declarations into real named modules/directories, validate, then update that plan with record_large_file_split."
      : hasHugeFile && changeMode === "bugfix" && minimalBugfixAllowed && safeToEdit
        ? "Proceed only with the declared minimal bugfix, add no responsibilities, and keep the split deferral reason in the final change intent."
      : hasHugeFile && changeMode === "emergency_hotfix" && safeToEdit
        ? "Proceed only with the smallest urgent fix, add no responsibilities, record why modularization was deferred, and schedule the split next."
        : hasHugeFile
          ? "Stop normal feature editing. Call plan_large_file_split and perform mechanical modularization first, then rerun preflight_change_scope with change_mode='mechanical_modularization'."
      : hasBlockingWarnings
            ? "Stop before editing. Narrow the planned files or explicitly expand the current requirement/scope contract."
            : "Planned files are within the current generic scope checks.";
  const requiredAction = hasHugeFile && hugeGateBlocked
    ? changeMode === "mechanical_modularization"
      ? "valid_split_plan"
      : "mechanical_modularization"
    : undefined;
  const allowedChangeModes = hasHugeFile
    ? (["mechanical_modularization", "bugfix", "emergency_hotfix"] as ChangeMode[])
    : undefined;

  const outputValue = {
    ok: safeToEdit,
    safe_to_edit: safeToEdit,
    advisory_only: !hasHugeFile,
    workflow_gate: hasHugeFile
      ? {
          code: "huge_file_modularization_required",
          active: hasBlockingWarnings,
          satisfied: !hasBlockingWarnings,
          required_action: requiredAction ?? changeMode,
          host_runtime_enforced: false,
          minimal_bugfix_allowed: minimalBugfixAllowed,
          emergency_hotfix_allowed: emergencyHotfixAllowed,
        }
      : null,
    change_mode: changeMode,
    recommended_action: recommendedAction,
    required_action: requiredAction,
    allowed_change_modes: allowedChangeModes,
    split_plan_validation: splitPlanValidation,
    adds_responsibility: args.adds_responsibility ?? null,
    defer_split_reason: deferReason || null,
    active_requirement: active ? { id: active.id, title: active.title } : null,
    requirement_resolution: {
      requested_req_id: args.req_id ?? null,
      requested_goal_key: args.goal_key ?? null,
      ambiguous: resolution.ambiguous,
      active_count: resolution.active_count,
    },
    intent: args.intent,
    files: normalizedFiles,
    requirement_mapping: {
      requirement_items: requirementItems,
      planned_changes: args.planned_changes ?? [],
    },
    scope_contract,
    development_warnings,
    quality_signals,
  };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson(
          "preflight_change_scope",
          outputValue,
          compactPreflightChangeScopeText(outputValue),
          args.format,
        ),
      },
    ],
  };
}
export async function handleSyncChangeIntent(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const db = context.getDb();
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;
  const sha256Hex = context.sha256Hex;
  const getFileStateHash = context.getFileStateHash;
  const {
    insertChangeLogStmt,
    upsertSyncedFileStateStmt,
    insertMemoryItemStmt,
    listPendingChangesStmt,
    deletePendingChangeStmt,
    deleteAllPendingChangesStmt,
  } = context.getStatements();

  const args = SyncChangeIntentArgsSchema.parse(rawArgs);
  const explicitFixPattern = args.fix_pattern
    ? normalizeFixPattern({
        ...args.fix_pattern,
        verification: args.fix_pattern.verification?.length ? args.fix_pattern.verification : args.verification,
        verification_gaps: args.fix_pattern.verification_gaps?.length
          ? args.fix_pattern.verification_gaps
          : args.verification_gaps,
      })
    : null;
  flushPendingChangeBuffer();
  const explicitFiles = (args.files ?? args.affected_files ?? []).filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const largeFileSplitDeferrals = (args.large_file_split_deferrals ?? []).map((deferral) => {
    const absolute = path.resolve(path.isAbsolute(deferral.file) ? deferral.file : path.join(projectRoot, deferral.file));
    const relative = path.relative(projectRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Large-file split deferral path must be under project_root: ${deferral.file}`);
    }
    return {
      file: normalizeToDbPath(relative),
      reason: deferral.reason.trim(),
      recorded_at: new Date().toISOString(),
    };
  });
  const resolution = resolveActiveRequirement(context, args);
  const active = resolution.requirement;
  if (!active) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: resolution.ambiguous
              ? "Multiple active requirements exist. Pass req_id or goal_key to sync_change_intent."
              : "No matching active requirement. Call start_requirement({ project_root, title, background }) first; optionally provide goal_key, then pass its req_id/goal_key here.",
            active_count: resolution.active_count,
          }),
        },
      ],
    };
  }

  const created: Array<{
    file_path: string;
    event: string;
    source: "args" | "pending" | "unspecified";
    change_log_id: number;
    memory_item_id: number;
  }> = [];
  let createdChange: { change_log_id: number; memory_item_id: number; file_count: number } | null = null;
  const fixPatternMemoryItem: { value: { id: number; kind: "fix_pattern"; title: string } | null } = { value: null };
  const synced_files: Array<{
    file_path: string;
    event: string;
    source: "args" | "pending" | "unspecified";
  }> = [];
  const insertTx = db.transaction(() => {
    const targets: Array<{
      rawFile: string;
      dbFilePath: string;
      event: string;
      source: "args" | "pending" | "unspecified";
    }> = [];

    if (explicitFiles.length) {
      for (const rawFile of explicitFiles) {
        const dbFilePath = normalizeToDbPath(rawFile);
        targets.push({ rawFile, dbFilePath, event: "manual", source: "args" });
      }
      for (const t of targets) {
        deletePendingChangeStmt.run(t.dbFilePath);
      }
    } else {
      const pendingAll = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const merged = mergePendingWithGit(pendingAll, { offset: 0, limit: MAX_PENDING_LIMIT });
      if (merged.page.length) {
        for (const p of merged.page) {
          targets.push({
            rawFile: p.file_path,
            dbFilePath: p.file_path,
            event: p.last_event,
            source: p.source === "git" ? "pending" : "pending",
          });
        }
        deleteAllPendingChangesStmt.run();
      } else {
        targets.push({
          rawFile: "(unspecified)",
          dbFilePath: "(unspecified)",
          event: "manual",
          source: "unspecified",
        });
      }
    }

    const uniqueTargets: typeof targets = [];
    const seenTargetPaths = new Set<string>();
    for (const target of targets) {
      const key =
        target.dbFilePath === "(unspecified)"
          ? "(unspecified)"
          : process.platform === "win32"
            ? target.dbFilePath.toLowerCase()
            : target.dbFilePath;
      if (seenTargetPaths.has(key)) continue;
      seenTargetPaths.add(key);
      uniqueTargets.push(target);
    }

    const fileStates = uniqueTargets.map((t) => {
      const isUnspecified = t.dbFilePath === "(unspecified)";
      return {
        rawFile: t.rawFile,
        file_path: t.dbFilePath,
        event: t.event,
        source: t.source,
        file_state_hash: isUnspecified ? null : getFileStateHash(t.rawFile),
        unspecified: isUnspecified,
      };
    });
    const concreteFileStates = fileStates.filter((f) => !f.unspecified);
    if (largeFileSplitDeferrals.length) {
      const syncedPathKeys = new Set(
        concreteFileStates.map((file) => process.platform === "win32" ? file.file_path.toLowerCase() : file.file_path),
      );
      for (const deferral of largeFileSplitDeferrals) {
        const deferralKey = process.platform === "win32" ? deferral.file.toLowerCase() : deferral.file;
        if (!syncedPathKeys.has(deferralKey)) {
          throw new Error(`Large-file split deferral must belong to this sync_change_intent file set: ${deferral.file}`);
        }
        const fileState = concreteFileStates.find((file) =>
          (process.platform === "win32" ? file.file_path.toLowerCase() : file.file_path) === deferralKey
        );
        let currentlyHuge = false;
        if (fileState && fileState.event !== "unlink") {
          const absPath = path.isAbsolute(fileState.rawFile)
            ? fileState.rawFile
            : path.join(projectRoot, fileState.rawFile);
          try {
            currentlyHuge = fs.statSync(absPath).isFile() && fileReachesLineThreshold(absPath, DEVELOPMENT_HUGE_FILE_LINES);
          } catch {
            currentlyHuge = false;
          }
        }
        if (!currentlyHuge && !hasUnfinishedLargeFileSplitPlan(context, active.id, deferral.file)) {
          throw new Error(
            `Large-file split deferral requires a currently huge file or an unfinished split plan for this requirement: ${deferral.file}`,
          );
        }
      }
    }
    const primaryFilePath =
      concreteFileStates.length === 1
        ? concreteFileStates[0].file_path
        : concreteFileStates.length > 1
          ? "(multiple)"
          : null;
    const filesJson = safeJson(
      concreteFileStates.map((f) => ({
        file_path: f.file_path,
        event: f.event,
        source: f.source,
        file_state_hash: f.file_state_hash,
      })),
    );
    const fileCount = concreteFileStates.length;

    const changeInfo = insertChangeLogStmt.run(active.id, primaryFilePath, args.intent, filesJson, fileCount);
    const change_log_id = Number(changeInfo.lastInsertRowid);
    const memoryMetadata = safeJson({
      change_log_id,
      files: concreteFileStates.map((f) => ({
        file_path: f.file_path,
        event: f.event,
        source: f.source,
        file_state_hash: f.file_state_hash,
      })),
      file_count: fileCount,
      verification: args.verification ?? [],
      verification_gaps: args.verification_gaps ?? [],
      large_file_split_deferrals: largeFileSplitDeferrals,
    });
    const memoryInfo = insertMemoryItemStmt.run(
      "change_intent",
      active.title,
      args.intent,
      concreteFileStates.length === 1 ? concreteFileStates[0].file_path : null,
      null,
      null,
      active.id,
      memoryMetadata,
      sha256Hex(`${args.intent}\n${concreteFileStates.map((f) => f.file_path).join("\n")}`),
    );
    const memory_item_id = Number(memoryInfo.lastInsertRowid);
    createdChange = { change_log_id, memory_item_id, file_count: fileCount };

    for (const f of fileStates) {
      synced_files.push({ file_path: f.file_path, event: f.event, source: f.source });
      created.push({
        file_path: f.file_path,
        event: f.event,
        source: f.source,
        change_log_id,
        memory_item_id,
      });

      if (!f.unspecified) {
        upsertSyncedFileStateStmt.run(f.file_path, f.file_state_hash, change_log_id);
      }

      if (!f.unspecified && f.event !== "unlink") {
        const abs = path.isAbsolute(f.rawFile)
          ? f.rawFile
          : path.join(projectRoot, f.rawFile);
        indexFile(abs, "manual");
      }
    }

    if (explicitFixPattern) {
      const sourceFiles = Array.from(new Set(synced_files.map((f) => f.file_path).filter((f) => f !== "(unspecified)")));
      const content = buildFixPatternContent(explicitFixPattern, args.intent, sourceFiles);
      const title = `Fix pattern: ${makePreviewText(explicitFixPattern.invariant, 120)}`;
      const memoryInfo = insertMemoryItemStmt.run(
        "fix_pattern",
        title,
        content,
        null,
        null,
        null,
        active.id,
        buildFixPatternMetadata({
          pattern: explicitFixPattern,
          intent: args.intent,
          files: sourceFiles,
          requirement_id: active.id,
          source_change_ids: createdChange ? [createdChange.change_log_id] : created.map((c) => c.change_log_id),
          verification: args.verification,
          verification_gaps: args.verification_gaps,
        }),
        sha256Hex(content),
      );
      fixPatternMemoryItem.value = { id: Number(memoryInfo.lastInsertRowid), kind: "fix_pattern", title };
    }
    if (args.complete_requirement) {
      completeRequirementMemoryItemsByReqId(active.id);
    }
  });
  try {
    insertTx();
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `sync_change_intent transaction failed: ${String(err)}` }) }],
    };
  }
  if (args.complete_requirement) {
    if (sessionActiveRequirement?.project_root === context.getProjectRoot() && sessionActiveRequirement.id === active.id) {
      sessionActiveRequirement = null;
    }
  }
  const development_warnings = [
    ...buildDevelopmentWarnings(synced_files, {
      includeUnspecified: synced_files.some((f) => f.file_path === "(unspecified)"),
    }),
    ...buildScopeDriftWarnings({
      requirement: active,
      intent: args.intent,
      files: synced_files,
    }),
  ];

  logActivity("sync_change_intent", {
    req_id: active.id,
    title: active.title,
    intent_preview: makePreviewText(args.intent, 200),
    files: synced_files.slice(0, 25),
    files_total: synced_files.length,
    fix_pattern_memory_id: fixPatternMemoryItem.value?.id ?? null,
    development_warnings: development_warnings.length,
    large_file_split_deferrals: largeFileSplitDeferrals.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          linked_to_requirement: { id: active.id, title: active.title },
          synced_files,
          created,
          created_change: createdChange,
          verification: args.verification ?? [],
          verification_gaps: args.verification_gaps ?? [],
          large_file_split_deferrals: largeFileSplitDeferrals,
          created_fix_pattern: fixPatternMemoryItem.value,
          requirement_completed: args.complete_requirement,
          development_warnings,
        }),
      },
    ],
  };
}
export async function handleGetPendingChanges(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const { listPendingChangesStmt } = context.getStatements();

  const args = GetPendingChangesArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const offset = args.offset;
  const limit = args.limit;
  const pendingDbRows = listPendingChangesStmt.all() as Array<{
    file_path: string;
    last_event: string;
    updated_at: string;
  }>;
  const mergedPending = mergePendingWithGit(pendingDbRows, { offset, limit });
  const total = mergedPending.total;
  const truncated = mergedPending.truncated;
  const pending = mergedPending.page;
  const resolution = resolveActiveRequirement(context, args);
  const activeForScope = resolution.requirement;
  const development_warnings = [
    ...buildDevelopmentWarnings(pending),
    ...(activeForScope ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending }) : []),
  ];

  logActivity("get_pending_changes", {
    total,
    offset,
    limit,
    returned: pending.length,
    truncated,
    development_warnings: development_warnings.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          total,
          offset,
          limit,
          truncated,
          pending,
          requirement_resolution: {
            requirement_id: activeForScope?.id ?? null,
            ambiguous: resolution.ambiguous,
            active_count: resolution.active_count,
          },
          development_warnings,
        }),
      },
    ],
  };
}
export async function handleCompleteRequirement(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = CompleteRequirementArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();

  const updated: Array<{ id: number }> = [];
  if (args.all_active) {
    try {
      const completedIds = completeAllActiveRequirementMemoryItems();
      for (const id of completedIds) updated.push({ id });
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: toolJson({ ok: false, error: `Failed to complete active requirements atomically: ${String(err)}` }) }],
      };
    }

    if (sessionActiveRequirement?.project_root === context.getProjectRoot()) sessionActiveRequirement = null;
    logActivity("complete_requirement", { all_active: true, completed: updated.map((u) => u.id) });
    return { content: [{ type: "text", text: toolJson({ ok: true, completed: updated }) }] };
  }

  const resolution = resolveActiveRequirement(context, args);
  if (resolution.ambiguous) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Multiple active requirements exist. Pass req_id or goal_key to complete_requirement.",
          active_count: resolution.active_count,
        }),
      }],
    };
  }
  const targetId = resolution.requirement?.id ?? null;
  if (!targetId) {
    return { content: [{ type: "text", text: toolJson({ ok: true, completed: [] }) }] };
  }

  try {
    completeRequirementMemoryItemsByReqId(targetId);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `Failed to complete requirement atomically: ${String(err)}` }) }],
    };
  }
  if (sessionActiveRequirement?.project_root === context.getProjectRoot() && sessionActiveRequirement.id === targetId) {
    sessionActiveRequirement = null;
  }

  logActivity("complete_requirement", { req_id: targetId });
  return { content: [{ type: "text", text: toolJson({ ok: true, completed: [{ id: targetId }] }) }] };
}
