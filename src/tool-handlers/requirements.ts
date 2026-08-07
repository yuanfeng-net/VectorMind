import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { MemoryItemRow, RequirementRow } from "../types.js";
import type { ChangeMode } from "../development-warnings.js";
import { CompleteRequirementArgsSchema, GetPendingChangesArgsSchema, PreflightChangeScopeArgsSchema, StartRequirementArgsSchema, SyncChangeIntentArgsSchema } from "../tool-schemas.js";
import { buildDevelopmentWarnings, buildRequirementMappingWarnings, buildRequirementScopeContract, buildRequirementStartWarnings, buildScopeDriftWarnings, getRequirementItems, getRequirementScopeContract, isDevelopmentWarningBlockingForChangeMode, mergeScopeContracts, normalizeRequirementItems, scopeContractHasRules } from "../development-warnings.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer, indexFile } from "../file-indexing.js";
import { buildFixPatternContent, buildFixPatternMetadata, buildFixPatternQualitySignals, collectRelevantFixPatterns, normalizeFixPattern } from "../fix-patterns.js";
import { completeAllActiveRequirementMemoryItems, completeRequirementMemoryItemsByReqId } from "../memory-mutations.js";
import { makePreviewText, parseMetadataJson } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { compactPreflightChangeScopeText, safeJson, toolJson } from "../tool-output.js";
import { normalizeRequirementGoalIdentity, sameRequirement } from "../context-governance.js";
import { requirementOverlapScore } from "../context-governance.js";
import { sanitizePersistentMemoryStrings, sanitizePersistentMemoryText, sanitizePersistentMemoryValue } from "../memory-safety.js";
import { DEVELOPMENT_HUGE_FILE_LINES } from "../config.js";
import { hashFileContentStreaming } from "../large-file-split.js";
import { resolvePathWithinRoot } from "../path-containment.js";

const UNFINISHED_SPLIT_PLAN_STATUSES = new Set(["planned", "in_progress", "partial", "needs_refinement"]);
const MAX_SYNC_RESPONSE_ITEMS = 100;
const MAX_SYNC_RESPONSE_ARRAY_CHARS = 12_000;
type CachedPreflightValue = Parameters<typeof compactPreflightChangeScopeText>[0] & Record<string, unknown>;
type StartRequirementWriteOutcome =
  | { kind: "created"; id: number; memoryId: number; closedPrevious: boolean }
  | { kind: "reused"; requirement: RequirementRow; reuseReason: string; closedPrevious: boolean }
  | { kind: "error"; error: string; code?: string; activeRequirements?: RequirementRow[]; activeCount?: number; overlapScore?: number };
const preflightResultCache = new Map<string, CachedPreflightValue>();

function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function canonicalizeIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeIdentity(item)]),
  );
}

function sortedUniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeIdentityText(value)).filter(Boolean))].sort();
}

function createSyncResponseBudget() {
  let remainingChars = MAX_SYNC_RESPONSE_ARRAY_CHARS;
  return function boundItems<T>(items: T[]): { page: T[]; total: number; truncated: boolean } {
    const page: T[] = [];
    for (const item of items) {
      if (page.length >= MAX_SYNC_RESPONSE_ITEMS) break;
      const itemChars = JSON.stringify(item).length + (page.length ? 1 : 0);
      if (itemChars > remainingChars) break;
      page.push(item);
      remainingChars -= itemChars;
    }
    return { page, total: items.length, truncated: page.length < items.length };
  };
}

function rememberPreflight(key: string, value: CachedPreflightValue): void {
  preflightResultCache.set(key, value);
  if (preflightResultCache.size <= 200) return;
  const oldest = preflightResultCache.keys().next().value as string | undefined;
  if (oldest) preflightResultCache.delete(oldest);
}

function renderPreflight(
  value: CachedPreflightValue,
  format: "compact" | "json",
): CallToolResult {
  return {
    content: [{
      type: "text",
      text: toolCompactOrJson(
        "preflight_change_scope",
        value,
        compactPreflightChangeScopeText(value),
        format,
      ),
    }],
  };
}

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
): {
  requirement: RequirementRow | undefined;
  ambiguous: boolean;
  active_count: number;
  requested_status: string | null;
  found: boolean;
} {
  const { listActiveRequirementsStmt } = context.getStatements();
  const activeCount = Number((context.getDb().prepare(
    `SELECT COUNT(*) AS count FROM requirements WHERE status = 'active'`,
  ).get() as { count: number } | undefined)?.count ?? 0);
  if (args.req_id) {
    const requirement = context.getDb().prepare(
      `SELECT id, title, status, context_data, goal_key, created_at
         FROM requirements WHERE id = ? LIMIT 1`,
    ).get(args.req_id) as RequirementRow | undefined;
    return {
      requirement: requirement?.status === "superseded" ? undefined : requirement,
      ambiguous: false,
      active_count: activeCount,
      requested_status: requirement?.status ?? null,
      found: !!requirement,
    };
  }
  if (args.goal_key?.trim()) {
    const requirement = context.getDb().prepare(
      `SELECT id, title, status, context_data, goal_key, created_at
         FROM requirements WHERE goal_key = ?
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                  updated_at DESC, id DESC
         LIMIT 1`,
    ).get(args.goal_key.trim()) as RequirementRow | undefined;
    return {
      requirement: requirement?.status === "superseded" ? undefined : requirement,
      ambiguous: false,
      active_count: activeCount,
      requested_status: requirement?.status ?? null,
      found: !!requirement,
    };
  }
  const active = listActiveRequirementsStmt.all(2) as RequirementRow[];
  return {
    requirement: active.length === 1 ? active[0] : undefined,
    ambiguous: activeCount > 1,
    active_count: activeCount,
    requested_status: active.length === 1 ? active[0].status : null,
    found: active.length === 1,
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
  const shouldClosePrevious = args.close_previous || args.previous_req_id != null;
  flushPendingChangeBuffer();
  const sanitizedTitle = sanitizePersistentMemoryText(args.title.trim());
  const sanitizedBackground = sanitizePersistentMemoryText(args.background?.trim() ?? "");
  const sanitizedItems = sanitizePersistentMemoryStrings(args.requirement_items);
  const persistentArgs = {
    ...args,
    title: sanitizedTitle.text,
    background: sanitizedBackground.text,
    requirement_items: sanitizedItems.values,
  };
  const scope_contract = buildRequirementScopeContract({
    title: persistentArgs.title,
    background: persistentArgs.background,
    scope_allow: args.scope_allow,
    scope_deny: args.scope_deny,
    allowed_paths: args.allowed_paths,
    denied_paths: args.denied_paths,
  });
  const requirement_items = normalizeRequirementItems(persistentArgs.requirement_items);
  const development_warnings = buildRequirementStartWarnings({
    title: persistentArgs.title,
    background: persistentArgs.background,
    close_previous: shouldClosePrevious,
  });

  const redaction = {
    applied: sanitizedTitle.redacted || sanitizedBackground.redacted || sanitizedItems.redacted,
    categories: [...new Set([...sanitizedTitle.categories, ...sanitizedBackground.categories, ...sanitizedItems.categories])].sort(),
  };
  const explicitGoalKey = args.goal_key?.trim() ?? "";
  const goalKey = explicitGoalKey ||
    `auto:${sha256Hex(normalizeRequirementGoalIdentity(persistentArgs.title, persistentArgs.background)).slice(0, 24)}`;
  const background = persistentArgs.background;
  const content = background ? `${persistentArgs.title}\n\n${background}` : persistentArgs.title;
  let writeOutcome: StartRequirementWriteOutcome;
  try {
    const writeTransaction = context.getDb().transaction((): StartRequirementWriteOutcome => {
      const currentByGoalKey = getActiveRequirementByGoalKeyStmt.get(goalKey) as RequirementRow | undefined;
      const currentActiveCandidates = listActiveRequirementsStmt.all(50) as RequirementRow[];
      const currentExactActive = !explicitGoalKey
        ? currentActiveCandidates.find((candidate) => sameRequirement(candidate, { ...persistentArgs, goal_key: goalKey }))
        : undefined;
      const currentActive = currentByGoalKey ?? currentExactActive;
      const currentReuseReason = currentByGoalKey
        ? "goal_key"
        : currentExactActive
          ? "same_requirement"
          : null;
      if (args.reuse_active && currentActive && currentReuseReason) {
        return {
          kind: "reused",
          requirement: currentActive,
          reuseReason: currentReuseReason,
          closedPrevious: false,
        };
      }

      if (shouldClosePrevious && !explicitGoalKey && !args.previous_req_id && currentActiveCandidates.length === 1) {
        const overlapScore = requirementOverlapScore(currentActiveCandidates[0], persistentArgs);
        if (overlapScore >= 0.55) {
          return {
            kind: "error",
            code: "POSSIBLE_REQUIREMENT_OVERLAP",
            error: "The new requirement strongly overlaps the active requirement. Reuse its goal_key to continue it, or pass previous_req_id explicitly to confirm replacement.",
            activeRequirements: currentActiveCandidates,
            activeCount: 1,
            overlapScore,
          };
        }
      }

      if (shouldClosePrevious && !args.previous_req_id && currentActiveCandidates.length > 1) {
        return {
          kind: "error",
          error: "Multiple active requirements exist. Pass previous_req_id to close one, or pass an existing goal_key to resume it.",
          activeRequirements: currentActiveCandidates.slice(0, 10),
          activeCount: currentActiveCandidates.length,
        };
      }

      let closedPrevious = false;
      const previousRequirementId = args.previous_req_id ??
        (currentActiveCandidates.length === 1 ? currentActiveCandidates[0].id : null);
      if (shouldClosePrevious && previousRequirementId) {
        const completed = completeRequirementMemoryItemsByReqId(previousRequirementId);
        if (!completed) {
          const raced = getActiveRequirementByGoalKeyStmt.get(goalKey) as RequirementRow | undefined;
          if (raced) {
            return {
              kind: "reused",
              requirement: raced,
              reuseReason: "concurrent_goal_key_insert",
              closedPrevious: false,
            };
          }
          return {
            kind: "error",
            error: `previous_req_id ${previousRequirementId} is not active and cannot be closed.`,
          };
        }
        closedPrevious = true;
      }

      let id: number;
      try {
        const info = insertRequirementStmt.run(persistentArgs.title, persistentArgs.background || null, goalKey);
        id = Number(info.lastInsertRowid);
      } catch (err) {
        const raced = getActiveRequirementByGoalKeyStmt.get(goalKey) as RequirementRow | undefined;
        if (!raced) throw err;
        return {
          kind: "reused",
          requirement: raced,
          reuseReason: "concurrent_goal_key_insert",
          closedPrevious,
        };
      }

      const memoryInfo = insertMemoryItemStmt.run(
        "requirement",
        persistentArgs.title,
        content,
        null,
        null,
        null,
        id,
        safeJson({ status: "active", goal_key: goalKey, scope_contract, requirement_items }),
        sha256Hex(content),
      );
      return {
        kind: "created",
        id,
        memoryId: Number(memoryInfo.lastInsertRowid),
        closedPrevious,
      };
    });
    writeOutcome = writeTransaction.immediate();
  } catch (err) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({ ok: false, error: `Failed to start requirement atomically: ${String(err)}` }),
      }],
    };
  }

  if (writeOutcome.kind === "error") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          code: writeOutcome.code,
          error: writeOutcome.error,
          overlap_score: writeOutcome.overlapScore,
          ...(writeOutcome.activeRequirements
            ? {
                active_count: writeOutcome.activeCount ?? writeOutcome.activeRequirements.length,
                active_requirements: writeOutcome.activeRequirements.map((candidate) => ({
                  id: candidate.id,
                  title: candidate.title,
                  goal_key: candidate.goal_key,
                })),
                recovery: writeOutcome.code === "POSSIBLE_REQUIREMENT_OVERLAP"
                  ? { action: "reuse_or_explicitly_replace", reuse_goal_key: writeOutcome.activeRequirements[0]?.goal_key, replace_with_previous_req_id: writeOutcome.activeRequirements[0]?.id }
                  : undefined,
              }
            : {}),
        }),
      }],
    };
  }

  if (writeOutcome.kind === "reused") {
    const memoryId = (getRequirementMemoryItemIdStmt.get(writeOutcome.requirement.id) as { id: number } | undefined)?.id ?? null;
    const activeScopeContract = getRequirementScopeContract(writeOutcome.requirement.id);
    const activeRequirementItems = getRequirementItems(writeOutcome.requirement.id);
    logActivity("start_requirement", {
      req_id: writeOutcome.requirement.id,
      title: writeOutcome.requirement.title,
      reused_active: true,
    });
    return {
      content: [{
        type: "text",
        text: toolJson({
          ok: true,
          requirement: { id: writeOutcome.requirement.id, title: writeOutcome.requirement.title },
          goal_key: writeOutcome.requirement.goal_key ?? goalKey,
          memory_item: { id: memoryId },
          reused: true,
          reuse_reason: writeOutcome.reuseReason,
          closed_previous: writeOutcome.closedPrevious,
          scope_contract: activeScopeContract,
          requirement_items: activeRequirementItems,
          development_warnings: [],
          redaction,
        }),
      }],
    };
  }

  logActivity("start_requirement", {
    req_id: writeOutcome.id,
    title: persistentArgs.title,
    closed_previous: writeOutcome.closedPrevious,
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
          requirement: { id: writeOutcome.id, title: persistentArgs.title },
          goal_key: goalKey,
          memory_item: { id: writeOutcome.memoryId },
          closed_previous: writeOutcome.closedPrevious,
          close_previous_ignored: false,
          scope_contract,
          requirement_items,
          development_warnings,
          redaction,
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
  const normalizedFiles = files.map(normalizeToDbPath);
  const explicitContract = buildRequirementScopeContract({
    title: active?.title ?? "",
    background: active?.context_data ?? "",
    scope_allow: args.scope_allow,
    scope_deny: args.scope_deny,
    allowed_paths: args.allowed_paths,
    denied_paths: args.denied_paths,
  });
  const persistedContract = active ? getRequirementScopeContract(active.id) : null;
  const mergedContract = mergeScopeContracts(persistedContract, explicitContract);
  const temporaryExactFileContract = !scopeContractHasRules(mergedContract) &&
      args.files === undefined &&
      (args.planned_files?.length ?? 0) > 0
    ? {
        allow_terms: [],
        deny_terms: [],
        allowed_paths: Array.from(new Set(normalizedFiles)),
        denied_paths: [],
        inferred_from: ["preflight.planned_files"],
      }
    : null;
  const scope_contract = mergeScopeContracts(mergedContract, temporaryExactFileContract);
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
      contract: scope_contract,
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

  const baseOutputValue = {
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
    scope_contract_persistence: temporaryExactFileContract
      ? "temporary_read_only"
      : scopeContractHasRules(scope_contract)
        ? "persisted_or_explicit"
        : "none",
    development_warnings,
    quality_signals,
  };
  const preflightIdempotencyKey = context.sha256Hex(
    JSON.stringify(canonicalizeIdentity(baseOutputValue)),
  );
  const cacheKey = `${context.getProjectRoot()}\n${preflightIdempotencyKey}`;
  const cachedPreflight = preflightResultCache.get(cacheKey);
  const reused = !!cachedPreflight;
  const outputValue = {
    ...(cachedPreflight ?? baseOutputValue),
    reused,
    idempotency_key: preflightIdempotencyKey,
  } as CachedPreflightValue;
  if (!cachedPreflight) {
    rememberPreflight(cacheKey, outputValue);
  }
  logActivity("preflight_change_scope", {
    req_id: active?.id ?? null,
    intent_preview: makePreviewText(args.intent, 200),
    change_mode: changeMode,
    files: files.slice(0, 25),
    files_total: files.length,
    development_warnings: development_warnings.length,
    reused,
    idempotency_key: preflightIdempotencyKey,
  });
  return renderPreflight(outputValue, args.format);
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
  } = context.getStatements();

  const parsedArgs = SyncChangeIntentArgsSchema.parse(rawArgs);
  const sanitizedIntent = sanitizePersistentMemoryText(parsedArgs.intent);
  const sanitizedVerification = sanitizePersistentMemoryStrings(parsedArgs.verification);
  const sanitizedVerificationGaps = sanitizePersistentMemoryStrings(parsedArgs.verification_gaps);
  const sanitizedFixPattern = sanitizePersistentMemoryValue(parsedArgs.fix_pattern);
  const args = {
    ...parsedArgs,
    intent: sanitizedIntent.text,
    verification: sanitizedVerification.values,
    verification_gaps: sanitizedVerificationGaps.values,
    fix_pattern: sanitizedFixPattern.value,
  };
  const syncRedaction = {
    applied: sanitizedIntent.redacted || sanitizedVerification.redacted || sanitizedVerificationGaps.redacted || sanitizedFixPattern.redacted,
    categories: [...new Set([
      ...sanitizedIntent.categories,
      ...sanitizedVerification.categories,
      ...sanitizedVerificationGaps.categories,
      ...sanitizedFixPattern.categories,
    ])].sort(),
  };
  const explicitFixPattern = args.fix_pattern
    ? normalizeFixPattern({
        ...args.fix_pattern,
        verification: args.fix_pattern.verification?.length ? args.fix_pattern.verification : args.verification,
        verification_gaps: args.fix_pattern.verification_gaps?.length
          ? args.fix_pattern.verification_gaps
          : args.verification_gaps,
      })
    : null;
  const toContainedFile = (input: string, allowMissing: boolean): { absolute: string; dbFilePath: string } => {
    const absolute = resolvePathWithinRoot(projectRoot, input, { allowMissing });
    const relative = path.relative(projectRoot, absolute);
    if (!relative || relative === ".") {
      throw new Error(`sync_change_intent file must identify an entry below project_root: ${input}`);
    }
    return { absolute, dbFilePath: normalizeToDbPath(relative) };
  };
  const explicitFileInputs = [...(args.files ?? []), ...(args.affected_files ?? [])].filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const explicitFiles = explicitFileInputs.map((rawFile) => {
    const contained = toContainedFile(rawFile, true);
    return { rawFile: contained.absolute, dbFilePath: contained.dbFilePath };
  });
  const largeFileSplitDeferrals = (args.large_file_split_deferrals ?? []).map((deferral) => {
    const contained = toContainedFile(deferral.file, true);
    return {
      file: contained.dbFilePath,
      reason: deferral.reason.trim(),
      recorded_at: new Date().toISOString(),
    };
  });
  const syncIdempotencyKey = args.idempotency_key?.trim() || null;
  const requestFingerprint = syncIdempotencyKey
    ? sha256Hex(JSON.stringify(canonicalizeIdentity({
        req_id: args.req_id ?? null,
        goal_key: normalizeIdentityText(args.goal_key),
        intent: normalizeIdentityText(args.intent),
        files: explicitFiles.map((file) => file.dbFilePath).sort(),
        verification: sortedUniqueStrings(args.verification ?? []),
        verification_gaps: sortedUniqueStrings(args.verification_gaps ?? []),
        fix_pattern: explicitFixPattern,
        large_file_split_deferrals: largeFileSplitDeferrals
          .map((deferral) => ({ file: deferral.file, reason: normalizeIdentityText(deferral.reason) }))
          .sort((left, right) => left.file.localeCompare(right.file)),
        pending_limit: args.pending_limit,
        complete_requirement: args.complete_requirement,
      })))
    : null;
  type ExistingSyncRow = {
    id: number;
    req_id: number;
    requirement_title: string;
    metadata_json: string | null;
  };
  const findExistingSync = (): ExistingSyncRow | undefined => {
    if (!syncIdempotencyKey) return undefined;
    return db.prepare(
      `SELECT mi.id, mi.req_id, r.title AS requirement_title, mi.metadata_json
         FROM memory_items mi
         JOIN requirements r ON r.id = mi.req_id
        WHERE mi.kind = 'change_intent'
          AND json_valid(COALESCE(mi.metadata_json, '{}'))
          AND json_extract(mi.metadata_json, '$.idempotency_key') = ?
        ORDER BY mi.updated_at DESC, mi.id DESC
        LIMIT 1`,
    ).get(syncIdempotencyKey) as ExistingSyncRow | undefined;
  };
  const replayExistingSync = (existing: ExistingSyncRow): CallToolResult => {
    const metadata = parseMetadataJson(existing.metadata_json);
    if (metadata.request_fingerprint !== requestFingerprint) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: toolJson({
            ok: false,
            error: "idempotency_key conflict: the key was already used with different sync_change_intent arguments",
            idempotency_key: syncIdempotencyKey,
          }),
        }],
      };
    }
    const storedFiles = Array.isArray(metadata.files)
      ? metadata.files
          .filter((file): file is Record<string, unknown> => !!file && typeof file === "object" && !Array.isArray(file))
          .map((file) => ({
            file_path: String(file.file_path ?? ""),
            event: String(file.event ?? "manual"),
            source: file.source === "args" || file.source === "pending" || file.source === "unspecified"
              ? file.source
              : "unspecified" as const,
          }))
          .filter((file) => file.file_path.length > 0)
      : [];
    const changeLogId = Number(metadata.change_log_id ?? 0);
    const developmentWarnings = buildDevelopmentWarnings(storedFiles, {
      includeUnspecified: storedFiles.some((file) => file.file_path === "(unspecified)"),
    });
    const boundResponseItems = createSyncResponseBudget();
    const boundedStoredFiles = boundResponseItems(storedFiles);
    const storedVerification = Array.isArray(metadata.verification) ? metadata.verification : [];
    const storedVerificationGaps = Array.isArray(metadata.verification_gaps) ? metadata.verification_gaps : [];
    const storedDeferrals = Array.isArray(metadata.large_file_split_deferrals)
      ? metadata.large_file_split_deferrals
      : [];
    const boundedVerification = boundResponseItems(storedVerification);
    const boundedVerificationGaps = boundResponseItems(storedVerificationGaps);
    const boundedDeferrals = boundResponseItems(storedDeferrals);
    const boundedWarnings = boundResponseItems(developmentWarnings);
    return {
      content: [{
        type: "text",
        text: toolJson({
          ok: true,
          linked_to_requirement: { id: existing.req_id, title: existing.requirement_title },
          synced_files: boundedStoredFiles.page,
          synced_files_total: boundedStoredFiles.total,
          synced_files_truncated: boundedStoredFiles.truncated,
          created: [],
          created_total: 0,
          created_truncated: false,
          created_change: {
            change_log_id: changeLogId,
            memory_item_id: existing.id,
            file_count: Number(metadata.file_count ?? storedFiles.filter((file) => file.file_path !== "(unspecified)").length),
          },
          verification: boundedVerification.page,
          verification_total: boundedVerification.total,
          verification_truncated: boundedVerification.truncated,
          verification_gaps: boundedVerificationGaps.page,
          verification_gaps_total: boundedVerificationGaps.total,
          verification_gaps_truncated: boundedVerificationGaps.truncated,
          large_file_split_deferrals: boundedDeferrals.page,
          large_file_split_deferrals_total: boundedDeferrals.total,
          large_file_split_deferrals_truncated: boundedDeferrals.truncated,
          created_fix_pattern: metadata.created_fix_pattern ?? null,
          requirement_completed: metadata.complete_requirement === true,
          pending_batch: metadata.pending_batch ?? null,
          reused: true,
          idempotency_key: syncIdempotencyKey,
          development_warnings: boundedWarnings.page,
          development_warnings_total: boundedWarnings.total,
          development_warnings_truncated: boundedWarnings.truncated,
        }),
      }],
    };
  };
  const existingBeforeResolution = findExistingSync();
  if (existingBeforeResolution) return replayExistingSync(existingBeforeResolution);

  flushPendingChangeBuffer();
  const resolution = resolveActiveRequirement(context, args);
  const active = resolution.requirement;
  if (!active) {
    const existingAfterResolution = findExistingSync();
    if (existingAfterResolution) return replayExistingSync(existingAfterResolution);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            code: resolution.ambiguous
              ? "MULTIPLE_ACTIVE_REQUIREMENTS"
              : resolution.requested_status === "superseded"
                ? "REQUIREMENT_SUPERSEDED"
                : resolution.found
                  ? "REQUIREMENT_NOT_WRITABLE"
              : "REQUIREMENT_NOT_ACTIVE_IN_PROJECT",
            error: resolution.ambiguous
              ? "Multiple active requirements exist. Pass req_id or goal_key to sync_change_intent."
              : resolution.requested_status === "superseded"
                ? "The requested requirement was superseded and cannot accept new change intent. Start a new requirement instead."
              : "No matching active requirement exists under the resolved project root. Call start_requirement({ project_root, title, background }) for a new goal, or inspect/resume an existing requirement.",
            project_root: context.getProjectRoot(),
            requested: {
              req_id: args.req_id ?? null,
              goal_key: args.goal_key?.trim() || null,
            },
            active_count: resolution.active_count,
            active_requirements: (context.getStatements().listActiveRequirementsStmt.all(10) as RequirementRow[])
              .map((requirement) => ({ id: requirement.id, title: requirement.title, goal_key: requirement.goal_key })),
            recovery: resolution.ambiguous
              ? { action: "pass_requirement_identity", tools: ["get_requirement_status"] }
              : resolution.requested_status === "superseded"
                ? { action: "start_replacement_requirement", tools: ["get_requirement_status", "start_requirement"] }
              : {
                  action: "inspect_or_resume_requirement",
                  tools: ["get_requirement_status", "resume_requirement", "start_requirement"],
                  hint: "Verify project_root matches the start_requirement call. Use project_root_mode=exact only for an intentionally independent nested project.",
                },
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
  const reusedSync = false;
  let pendingBatch: {
    limit: number;
    total: number;
    processed: number;
    remaining: number;
    truncated: boolean;
  } | null = null;
  const fixPatternMemoryItem: { value: { id: number; kind: "fix_pattern"; title: string } | null } = { value: null };
  const synced_files: Array<{
    file_path: string;
    event: string;
    source: "args" | "pending" | "unspecified";
  }> = [];
  let transactionReplay: ExistingSyncRow | undefined;
  const insertTx = db.transaction(() => {
    transactionReplay = findExistingSync();
    if (transactionReplay) return;
    const pendingPathsToDelete = new Set<string>();
    const targets: Array<{
      rawFile: string;
      dbFilePath: string;
      event: string;
      source: "args" | "pending" | "unspecified";
    }> = [];

    if (explicitFiles.length) {
      for (const file of explicitFiles) {
        targets.push({ rawFile: file.rawFile, dbFilePath: file.dbFilePath, event: "manual", source: "args" });
        pendingPathsToDelete.add(file.dbFilePath);
      }
    } else {
      const pendingAll = listPendingChangesStmt.all() as Array<{
        file_path: string;
        last_event: string;
        updated_at: string;
      }>;
      const merged = mergePendingWithGit(pendingAll, { offset: 0, limit: args.pending_limit });
      pendingBatch = {
        limit: args.pending_limit,
        total: merged.total,
        processed: merged.page.length,
        remaining: merged.remaining,
        truncated: merged.truncated,
      };
      if (args.complete_requirement && merged.remaining > 0) {
        throw new Error(
          `Cannot complete requirement while ${merged.remaining} pending change(s) remain after this bounded batch. ` +
          "Run sync_change_intent with complete_requirement=false until pending_batch.remaining is 0, then complete it.",
        );
      }
      if (merged.page.length) {
        for (const p of merged.page) {
          const contained = toContainedFile(p.file_path, p.last_event === "unlink");
          targets.push({
            rawFile: contained.absolute,
            dbFilePath: contained.dbFilePath,
            event: p.last_event,
            source: "pending",
          });
          pendingPathsToDelete.add(p.file_path);
        }
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
    for (const pendingPath of pendingPathsToDelete) deletePendingChangeStmt.run(pendingPath);
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
      idempotency_key: syncIdempotencyKey,
      request_fingerprint: requestFingerprint,
      pending_batch: pendingBatch,
      complete_requirement: args.complete_requirement,
      redaction: syncRedaction,
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
      if (!completeRequirementMemoryItemsByReqId(active.id)) {
        throw new Error(`Requirement ${active.id} is no longer active and cannot be completed.`);
      }
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
  if (transactionReplay) return replayExistingSync(transactionReplay);
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
  const boundResponseItems = createSyncResponseBudget();
  const boundedSyncedFiles = boundResponseItems(synced_files);
  const boundedCreated = boundResponseItems(created);
  const boundedVerification = boundResponseItems(args.verification ?? []);
  const boundedVerificationGaps = boundResponseItems(args.verification_gaps ?? []);
  const boundedDeferrals = boundResponseItems(largeFileSplitDeferrals);
  const boundedWarnings = boundResponseItems(development_warnings);

  logActivity("sync_change_intent", {
    req_id: active.id,
    title: active.title,
    intent_preview: makePreviewText(args.intent, 200),
    files: synced_files.slice(0, 25),
    files_total: synced_files.length,
    fix_pattern_memory_id: fixPatternMemoryItem.value?.id ?? null,
    development_warnings: development_warnings.length,
    large_file_split_deferrals: largeFileSplitDeferrals.length,
    pending_batch: pendingBatch,
    reused: reusedSync,
    idempotency_key: syncIdempotencyKey,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          linked_to_requirement: { id: active.id, title: active.title },
          synced_files: boundedSyncedFiles.page,
          synced_files_total: boundedSyncedFiles.total,
          synced_files_truncated: boundedSyncedFiles.truncated,
          created: boundedCreated.page,
          created_total: boundedCreated.total,
          created_truncated: boundedCreated.truncated,
          created_change: createdChange,
          verification: boundedVerification.page,
          verification_total: boundedVerification.total,
          verification_truncated: boundedVerification.truncated,
          verification_gaps: boundedVerificationGaps.page,
          verification_gaps_total: boundedVerificationGaps.total,
          verification_gaps_truncated: boundedVerificationGaps.truncated,
          large_file_split_deferrals: boundedDeferrals.page,
          large_file_split_deferrals_total: boundedDeferrals.total,
          large_file_split_deferrals_truncated: boundedDeferrals.truncated,
          created_fix_pattern: fixPatternMemoryItem.value,
          requirement_completed: args.complete_requirement,
          pending_batch: pendingBatch,
          reused: reusedSync,
          idempotency_key: syncIdempotencyKey,
          development_warnings: boundedWarnings.page,
          development_warnings_total: boundedWarnings.total,
          development_warnings_truncated: boundedWarnings.truncated,
          redaction: syncRedaction,
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
    if (!completeRequirementMemoryItemsByReqId(targetId)) {
      return {
        isError: true,
        content: [{ type: "text", text: toolJson({ ok: false, error: `Requirement ${targetId} is no longer active.` }) }],
      };
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `Failed to complete requirement atomically: ${String(err)}` }) }],
    };
  }
  logActivity("complete_requirement", { req_id: targetId });
  return { content: [{ type: "text", text: toolJson({ ok: true, completed: [{ id: targetId }] }) }] };
}
