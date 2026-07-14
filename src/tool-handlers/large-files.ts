import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { RequirementRow } from "../types.js";
import { DEVELOPMENT_BLOCK_FILE_LINES, DEVELOPMENT_HUGE_FILE_LINES } from "../config.js";
import { PlanLargeFileSplitArgsSchema, RecordLargeFileSplitArgsSchema } from "../tool-schemas.js";
import { isLikelySourceImplementationFile } from "../development-warnings.js";
import {
  buildLargeFileSplitPlan,
  countFileLinesStreaming,
  hashFileContentStreaming,
  hasOrdinalModuleName,
  LARGE_FILE_SPLIT_PLANNER_VERSION,
} from "../large-file-split.js";
import type { LargeFileSplitModuleOverride, LargeFileSplitPlan } from "../large-file-split.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { logActivity } from "../activity-log.js";
import { resolveProjectPathUnderRoot, resolveReadPathUnderProjectRoot } from "../project-files.js";
import { compactLargeFileSplitPlanText, safeJson, toolJson } from "../tool-output.js";
import { parseMetadataJson } from "../memory-recall.js";
import { looksLikeGeneratedFile, shouldIgnoreDbFilePath } from "../path-rules.js";

function readFileHead(absPath: string, maxBytes = 16_384): string {
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function filePathIdentity(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validSplitPlanStatus(status: unknown): status is "planned" | "in_progress" | "partial" | "resolved" | "needs_refinement" {
  return ["planned", "in_progress", "partial", "resolved", "needs_refinement"].includes(String(status));
}

type LargeFilePlanMemoryRow = {
  id: number;
  kind: string;
  content: string;
  req_id: number | null;
  file_path: string | null;
  metadata_json: string | null;
};

function parsePersistedPlan(content: string): LargeFileSplitPlan | null {
  try {
    const payload = JSON.parse(content) as { plan?: unknown };
    return payload?.plan && typeof payload.plan === "object" && !Array.isArray(payload.plan)
      ? payload.plan as LargeFileSplitPlan
      : null;
  } catch {
    return null;
  }
}

function compactPlanMetadata(args: {
  status: string;
  file: string;
  sourceStateHash: string | null;
  plannerFingerprint: string;
  requirement: RequirementRow;
  plan: LargeFileSplitPlan;
  currentStateHash?: string | null;
  verification?: string[];
  verificationGaps?: string[];
}): Record<string, unknown> {
  return {
    type: "large_file_split_plan",
    status: args.status,
    file: args.file,
    source_state_hash: args.sourceStateHash,
    source_content_hash: args.sourceStateHash,
    planner_fingerprint: args.plannerFingerprint,
    planner_version: LARGE_FILE_SPLIT_PLANNER_VERSION,
    current_state_hash: args.currentStateHash ?? args.sourceStateHash,
    requirement_id: args.requirement.id,
    goal_key: args.requirement.goal_key ?? null,
    plan_ok: args.plan.ok,
    coverage_complete: args.plan.coverage.complete,
    module_constraints_satisfied: args.plan.module_constraints?.satisfied === true,
    target_paths: args.plan.modules.map((module) => module.target_path),
    analysis_mode: args.plan.analysis_mode,
    confidence: args.plan.confidence,
    verification: args.verification ?? [],
    verification_gaps: args.verificationGaps ?? args.plan.warnings,
  };
}

function supersedePlanRow(
  context: ToolHandlerContext,
  row: LargeFilePlanMemoryRow,
  replacementPlanId: number,
  reason: string,
): void {
  const metadata = parseMetadataJson(row.metadata_json);
  let content = row.content;
  try {
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    content = safeJson({
      ...parsed,
      status: "superseded",
      superseded: true,
      superseded_reason: reason,
      superseded_by_plan_id: replacementPlanId,
    }) ?? row.content;
  } catch {
    // Keep legacy content intact while making metadata authoritative.
  }
  context.getDb().prepare(
    `UPDATE memory_items
        SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND kind = 'large_file_split_plan'`,
  ).run(
    content,
    safeJson({
      ...metadata,
      status: "superseded",
      superseded: true,
      superseded_reason: reason,
      superseded_by_plan_id: replacementPlanId,
      superseded_at: new Date().toISOString(),
    }),
    context.sha256Hex(content),
    row.id,
  );
}

function resolveSplitRequirement(
  context: ToolHandlerContext,
  args: { req_id?: number; goal_key?: string },
): { requirement: RequirementRow | undefined; ambiguous: boolean; active_count: number } {
  const {
    getActiveRequirementByIdStmt,
    getActiveRequirementByGoalKeyStmt,
    listActiveRequirementsStmt,
  } = context.getStatements();
  if (args.req_id) {
    const requirement = getActiveRequirementByIdStmt.get(args.req_id) as RequirementRow | undefined;
    return { requirement, ambiguous: false, active_count: requirement ? 1 : 0 };
  }
  if (args.goal_key?.trim()) {
    const requirement = getActiveRequirementByGoalKeyStmt.get(args.goal_key.trim()) as RequirementRow | undefined;
    return { requirement, ambiguous: false, active_count: requirement ? 1 : 0 };
  }
  const active = listActiveRequirementsStmt.all(2) as RequirementRow[];
  return {
    requirement: active.length === 1 ? active[0] : undefined,
    ambiguous: active.length > 1,
    active_count: active.length,
  };
}

function splitRequirementError(
  resolution: ReturnType<typeof resolveSplitRequirement>,
): CallToolResult | null {
  if (resolution.requirement) return null;
  return {
    isError: true,
    content: [{
      type: "text",
      text: toolJson({
        ok: false,
        error: resolution.ambiguous
          ? "Multiple active requirements exist. Pass req_id or goal_key for the large-file split workflow."
          : "No matching active requirement. Start or resume the requirement before planning or recording a large-file split.",
        active_count: resolution.active_count,
      }),
    }],
  };
}

export async function handlePlanLargeFileSplit(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;
  const { insertMemoryItemStmt } = context.getStatements();

  const args = PlanLargeFileSplitArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const requirementResolution = resolveSplitRequirement(context, args);
  const requirementError = splitRequirementError(requirementResolution);
  if (requirementError) return requirementError;
  const active = requirementResolution.requirement!;
  const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
    };
  }
  if (!stat.isFile()) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
  }
  if (!isLikelySourceImplementationFile(resolved.dbFilePath)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "Not a recognized source implementation file",
            file_path: resolved.dbFilePath,
          }),
        },
      ],
    };
  }
  if (shouldIgnoreDbFilePath(resolved.dbFilePath) || looksLikeGeneratedFile(readFileHead(resolved.absPath))) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Generated, vendored, dependency, or build-output source files must be regenerated or excluded, not mechanically modularized.",
          file_path: resolved.dbFilePath,
        }),
      }],
    };
  }

  const fileBaseName = path.basename(resolved.dbFilePath, path.extname(resolved.dbFilePath));
  const fileParentDir = path.dirname(resolved.dbFilePath).replace(/\\/g, "/");
  const defaultTargetDir = fileParentDir === "." ? fileBaseName : `${fileParentDir}/${fileBaseName}`;
  let targetDir: string;
  try {
    const resolvedTargetDir = resolveProjectPathUnderRoot(
      projectRoot,
      normalizeToDbPath,
      args.target_dir ?? defaultTargetDir,
      { allowRoot: true },
    );
    targetDir = resolvedTargetDir.dbFilePath;
    if (filePathIdentity(targetDir) === filePathIdentity(resolved.dbFilePath)) {
      throw new Error("Large-file split target_dir must not be the source file.");
    }
    if (fs.existsSync(resolvedTargetDir.absPath) && !fs.statSync(resolvedTargetDir.absPath).isDirectory()) {
      throw new Error(`Large-file split target_dir must be a directory boundary: ${targetDir}`);
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }],
    };
  }

  let moduleOverrides: LargeFileSplitModuleOverride[] | undefined;
  try {
    const seenModules = new Set<string>();
    const seenTargets = new Set<string>();
    moduleOverrides = args.module_overrides?.map((override) => {
      const moduleName = override.module.trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(moduleName) || hasOrdinalModuleName(moduleName)) {
        throw new Error(`Invalid semantic module name: ${override.module}`);
      }
      const moduleKey = moduleName.toLowerCase();
      if (seenModules.has(moduleKey)) throw new Error(`Duplicate module override: ${moduleName}`);
      seenModules.add(moduleKey);

      const targetPath = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, override.target_path).dbFilePath;
      const targetKey = filePathIdentity(targetPath);
      if (seenTargets.has(targetKey)) throw new Error(`Duplicate module target_path: ${targetPath}`);
      seenTargets.add(targetKey);
      const relativeToTargetDir = path.posix.relative(targetDir.replace(/\\/g, "/"), targetPath.replace(/\\/g, "/"));
      if (relativeToTargetDir.startsWith("../") || relativeToTargetDir === ".." || path.posix.isAbsolute(relativeToTargetDir)) {
        throw new Error(`module_overrides target_path must stay under target_dir ${targetDir}: ${targetPath}`);
      }
      const normalizedTarget = targetPath.toLowerCase();
      const targetBase = path.basename(normalizedTarget);
      const sourceExtension = path.extname(resolved.dbFilePath).toLowerCase();
      const targetExtension = path.extname(targetPath).toLowerCase();
      const targetAbsPath = path.join(projectRoot, targetPath);
      if (
        targetKey === filePathIdentity(resolved.dbFilePath) ||
        !sourceExtension || targetExtension !== sourceExtension ||
        fs.existsSync(targetAbsPath) && fs.statSync(targetAbsPath).isDirectory() ||
        hasOrdinalModuleName(targetPath) ||
        shouldIgnoreDbFilePath(targetPath) ||
        normalizedTarget.includes(".parts/") ||
        targetBase.includes(".generated.") ||
        /(?:^|[_-])part\d*(?:\.|$)/.test(targetBase)
      ) {
        throw new Error(`Invalid module override target_path: ${targetPath}`);
      }
      return {
        module: moduleName,
        target_path: targetPath,
        declaration_names: override.declaration_names
          ? [...new Set(override.declaration_names.map((name) => name.trim()))].sort()
          : undefined,
        line_ranges: override.line_ranges
          ? [...override.line_ranges].sort((a, b) => a.start - b.start || a.end - b.end)
          : undefined,
      };
    });
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: String(err) }) }],
    };
  }

  const effectiveMaxDeclarations = Math.min(200, args.max_declarations_per_module);
  const effectiveMaxLines = Math.min(DEVELOPMENT_BLOCK_FILE_LINES, args.max_lines_per_module);
  const fingerprintPayload = {
    planner_version: LARGE_FILE_SPLIT_PLANNER_VERSION,
    target_dir: targetDir,
    max_modules: args.max_modules,
    max_declarations_per_module: effectiveMaxDeclarations,
    max_lines_per_module: effectiveMaxLines,
    module_overrides: moduleOverrides ?? [],
  };
  const plannerFingerprint = context.sha256Hex(safeJson(fingerprintPayload) ?? "{}");
  const plan = await buildLargeFileSplitPlan({
    filePath: resolved.dbFilePath,
    absPath: resolved.absPath,
    intent: args.intent,
    targetDir,
    maxModules: args.max_modules,
    hugeThresholdLines: DEVELOPMENT_HUGE_FILE_LINES,
    maxDeclarationsPerModule: effectiveMaxDeclarations,
    maxEstimatedLinesPerModule: effectiveMaxLines,
    moduleOverrides,
    plannerFingerprint,
  });
  if (plan.line_count < DEVELOPMENT_HUGE_FILE_LINES) {
    return {
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          file_path: resolved.dbFilePath,
          line_count: plan.line_count,
          huge_threshold_lines: DEVELOPMENT_HUGE_FILE_LINES,
          recommended_action:
            "This file is not above the huge-file threshold. Use normal focused modularity rules unless the user explicitly asked for refactoring.",
        }),
      }],
    };
  }

  const sourceStateHash = plan.source_content_hash;
  const existingRows = context.getDb().prepare(
    `SELECT id, kind, content, req_id, file_path, metadata_json
       FROM memory_items
      WHERE kind = 'large_file_split_plan' AND req_id = ? AND file_path = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 20`,
  ).all(active.id, resolved.dbFilePath) as LargeFilePlanMemoryRow[];
  const activeStatuses = new Set(["planned", "in_progress", "partial", "needs_refinement"]);
  const progressingRows = existingRows.filter((row) => {
    const status = String(parseMetadataJson(row.metadata_json).status);
    return status === "in_progress" || status === "partial";
  });
  const reusable = existingRows.find((row) => {
    const metadata = parseMetadataJson(row.metadata_json);
    const status = String(metadata.status);
    const expectedState = (status === "in_progress" || status === "partial") && typeof metadata.current_state_hash === "string"
      ? metadata.current_state_hash
      : typeof metadata.source_content_hash === "string"
        ? metadata.source_content_hash
        : metadata.source_state_hash;
    return activeStatuses.has(String(metadata.status)) &&
      expectedState === sourceStateHash &&
      metadata.planner_fingerprint === plannerFingerprint &&
      !!parsePersistedPlan(row.content);
  });
  if (progressingRows.length && (progressingRows.length !== 1 || reusable?.id !== progressingRows[0].id)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "An in-progress or partial split plan already owns this requirement/file. Resume it with record_large_file_split or complete/defer the requirement before replanning.",
          active_progress_plans: progressingRows.map((row) => ({
            plan_id: row.id,
            status: parseMetadataJson(row.metadata_json).status,
          })),
        }),
      }],
    };
  }
  if (reusable) {
    const reusedPlan = parsePersistedPlan(reusable.content)!;
    for (const duplicate of existingRows) {
      if (duplicate.id === reusable.id) continue;
      const metadata = parseMetadataJson(duplicate.metadata_json);
      if (!activeStatuses.has(String(metadata.status))) continue;
      if (metadata.status === "planned" || metadata.status === "needs_refinement") {
        supersedePlanRow(context, duplicate, reusable.id, "duplicate_plan_reused");
      }
    }
    logActivity("plan_large_file_split", {
      plan_id: reusable.id,
      req_id: active.id,
      file_path: reusedPlan.file_path,
      reused: true,
    });
    return {
      content: [{
        type: "text",
        text: toolCompactOrJson(
          "plan_large_file_split",
          {
            ...reusedPlan,
            plan_id: reusable.id,
            plan_status: parseMetadataJson(reusable.metadata_json).status,
            source_state_hash: sourceStateHash,
            reused: true,
            requirement: { id: active.id, title: active.title, goal_key: active.goal_key ?? null },
          },
          compactLargeFileSplitPlanText({
            ...reusedPlan,
            plan_id: reusable.id,
            plan_status: String(parseMetadataJson(reusable.metadata_json).status ?? "planned"),
            requirement: { id: active.id, title: active.title },
          }),
          args.format,
        ),
      }],
    };
  }
  const planStatus = plan.ok ? "planned" : "needs_refinement";
  const planMetadata = compactPlanMetadata({
    status: planStatus,
    file: resolved.dbFilePath,
    sourceStateHash,
    plannerFingerprint,
    requirement: active,
    plan,
  });
  const planContent = safeJson({
    type: "large_file_split_plan",
    status: planStatus,
    file: resolved.dbFilePath,
    requirement: { id: active.id, title: active.title, goal_key: active.goal_key ?? null },
    source_state_hash: sourceStateHash,
    source_content_hash: sourceStateHash,
    planner_fingerprint: plannerFingerprint,
    plan,
  });
  const planInfo = insertMemoryItemStmt.run(
    "large_file_split_plan",
    `large-file-split:${resolved.dbFilePath}`,
    planContent,
    resolved.dbFilePath,
    null,
    null,
    active.id,
    safeJson(planMetadata),
    context.sha256Hex(`${resolved.dbFilePath}\n${sourceStateHash ?? "missing"}\n${safeJson(plan)}`),
  );
  const planId = Number(planInfo.lastInsertRowid);
  for (const stale of existingRows) {
    const metadata = parseMetadataJson(stale.metadata_json);
    if (metadata.status !== "planned" && metadata.status !== "needs_refinement") continue;
    const reason = metadata.source_content_hash === sourceStateHash || metadata.source_state_hash === sourceStateHash
      ? "planner_configuration_changed"
      : "source_content_changed";
    supersedePlanRow(context, stale, planId, reason);
  }

  logActivity("plan_large_file_split", {
    plan_id: planId,
    req_id: active.id,
    file_path: plan.file_path,
    line_count: plan.line_count,
    target_dir: plan.target_dir,
    modules: plan.modules.map((m) => m.module),
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson(
          "plan_large_file_split",
          {
            ...plan,
            plan_id: planId,
            plan_status: planStatus,
            source_state_hash: sourceStateHash,
            requirement: { id: active.id, title: active.title, goal_key: active.goal_key ?? null },
          },
          compactLargeFileSplitPlanText({
            ...plan,
            plan_id: planId,
            plan_status: planStatus,
            requirement: { id: active.id, title: active.title },
          }),
          args.format,
        ),
      },
    ],
  };
}
export async function handleRecordLargeFileSplit(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;
  const sha256Hex = context.sha256Hex;
  const { getMemoryItemByIdStmt } = context.getStatements();

  const args = RecordLargeFileSplitArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const requirementResolution = resolveSplitRequirement(context, args);
  const requirementError = splitRequirementError(requirementResolution);
  if (requirementError) return requirementError;
  const active = requirementResolution.requirement!;
  const resolvedFile = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, args.file);
  const normalizedFile = resolvedFile.dbFilePath;
  const planRow = getMemoryItemByIdStmt.get(args.plan_id) as LargeFilePlanMemoryRow | undefined;
  const planMetadata = parseMetadataJson(planRow?.metadata_json);
  const legacyPlan = planMetadata.plan && typeof planMetadata.plan === "object" && !Array.isArray(planMetadata.plan)
    ? planMetadata.plan as LargeFileSplitPlan
    : null;
  const persistedPlan = planRow ? (parsePersistedPlan(planRow.content) ?? legacyPlan) : null;
  const storedStatus = planMetadata.status;
  if (
    !planRow ||
    planRow.kind !== "large_file_split_plan" ||
    planMetadata.type !== "large_file_split_plan" ||
    planRow.req_id !== active.id ||
    planMetadata.file !== normalizedFile ||
    !persistedPlan ||
    !validSplitPlanStatus(storedStatus)
  ) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "plan_id does not identify a compatible large-file split plan for this requirement and file.",
          plan_id: args.plan_id,
          req_id: active.id,
          file_path: normalizedFile,
        }),
      }],
    };
  }
  if (storedStatus === "needs_refinement") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "This split plan is incomplete and must be refined before progress can be recorded.",
          plan_id: args.plan_id,
        }),
      }],
    };
  }
  const modules = (args.modules ?? []).map((modulePath) =>
    resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, modulePath).dbFilePath
  );
  const ordinalModules = modules.filter(hasOrdinalModuleName);
  const ignoredModules = modules.filter(shouldIgnoreDbFilePath);
  const fakeSplitModules = modules.filter((modulePath) => {
    const normalized = modulePath.replace(/\\/g, "/").toLowerCase();
    const base = path.basename(normalized);
    return normalized.includes(".parts/") || base.includes(".generated.") || /(?:^|[_-])part\d*(?:\.|$)/.test(base);
  });
  if (ordinalModules.length || ignoredModules.length || fakeSplitModules.length) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "Ordinal-prefixed, generated, parts, or ignored module paths are not allowed for mechanical modularization.",
            file_path: normalizedFile,
            invalid_modules: [...new Set([...ordinalModules, ...ignoredModules, ...fakeSplitModules])],
            required_naming:
              "Use stable semantic names such as config.ts, api.ts, service.ts, storage.ts, ui.ts, or maintenance.ts; do not use 1_xxx, 2_xxx, 03-xxx, or other ordering prefixes.",
          }),
        },
      ],
    };
  }
  const allowedTransitions: Record<"planned" | "in_progress" | "partial" | "resolved", string[]> = {
    planned: ["in_progress", "partial", "resolved"],
    in_progress: ["partial", "resolved"],
    partial: ["in_progress", "resolved"],
    resolved: ["resolved"],
  };
  if (!allowedTransitions[storedStatus].includes(args.status)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: `Invalid split plan status transition: ${storedStatus} -> ${args.status}.`,
          allowed_statuses: allowedTransitions[storedStatus],
        }),
      }],
    };
  }
  const storedPlanModules = persistedPlan.modules.map((module) => module.target_path);
  const unexpectedModules = modules.filter((modulePath) => !storedPlanModules.includes(modulePath));
  if (args.status === "planned" && modules.length) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Planned status uses the persisted plan modules and does not accept caller module overrides.",
          plan_id: args.plan_id,
        }),
      }],
    };
  }
  if (unexpectedModules.length) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Progress modules must be a subset of the persisted split plan.",
          unexpected_modules: unexpectedModules,
        }),
      }],
    };
  }
  const missingModules = modules.filter((modulePath) => {
    try {
      return !fs.statSync(path.join(projectRoot, modulePath)).isFile();
    } catch {
      return true;
    }
  });
  const missingPlannedModules = storedPlanModules.filter((modulePath) => !modules.includes(modulePath));
  if (
    (args.status === "partial" || args.status === "resolved") && (!modules.length || missingModules.length) ||
    args.status === "in_progress" && modules.length > 0 && missingModules.length > 0
  ) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Submitted in-progress, partial, or resolved module paths must exist under project_root; partial/resolved also require at least one module.",
          missing_modules: missingModules,
        }),
      }],
    };
  }
  if (args.status === "resolved" && missingPlannedModules.length) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Resolved status must account for every module in the persisted split plan.",
          missing_planned_modules: missingPlannedModules,
        }),
      }],
    };
  }

  const actualRemainingLines = fs.existsSync(resolvedFile.absPath)
    ? await countFileLinesStreaming(resolvedFile.absPath)
    : 0;
  const verification = args.verification ?? [];
  const verificationGaps = args.verification_gaps ?? [];
  const oversizedResolvedModules: Array<{ file: string; lines: number }> = [];
  if (args.status === "resolved") {
    for (const modulePath of modules) {
      const lines = await countFileLinesStreaming(path.join(projectRoot, modulePath));
      if (lines >= DEVELOPMENT_BLOCK_FILE_LINES) oversizedResolvedModules.push({ file: modulePath, lines });
    }
  }
  if (args.remaining_lines != null && args.remaining_lines !== actualRemainingLines) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "remaining_lines does not match the current source file.",
          provided: args.remaining_lines,
          actual: actualRemainingLines,
        }),
      }],
    };
  }
  if (
    args.status === "resolved" &&
    (
      actualRemainingLines >= DEVELOPMENT_BLOCK_FILE_LINES ||
      oversizedResolvedModules.length > 0 ||
      verification.length === 0 ||
      verificationGaps.length > 0
    )
  ) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: toolJson({
          ok: false,
          error: "Resolved status requires the source and every target module below the very-large threshold, verification evidence, and no verification gaps.",
          remaining_lines: actualRemainingLines,
          resolved_line_threshold: DEVELOPMENT_BLOCK_FILE_LINES,
          oversized_modules: oversizedResolvedModules,
          verification,
          verification_gaps: verificationGaps,
        }),
      }],
    };
  }

  const currentStateHash = fs.existsSync(resolvedFile.absPath)
    ? await hashFileContentStreaming(resolvedFile.absPath)
    : context.sha256Hex("missing");
  const originalSourceStateHash = typeof planMetadata.source_content_hash === "string"
    ? planMetadata.source_content_hash
    : typeof planMetadata.source_state_hash === "string"
      ? planMetadata.source_state_hash
      : null;
  const meta = {
    ...compactPlanMetadata({
      status: args.status,
      file: normalizedFile,
      sourceStateHash: originalSourceStateHash,
      plannerFingerprint: typeof planMetadata.planner_fingerprint === "string"
        ? planMetadata.planner_fingerprint
        : persistedPlan.planner_fingerprint,
      currentStateHash,
      requirement: active,
      plan: persistedPlan,
      verification,
      verificationGaps,
    }),
    progress_modules: modules,
    remaining_lines: actualRemainingLines,
    updated_at: new Date().toISOString(),
  };
  const content = safeJson({
    type: "large_file_split_plan",
    summary: args.summary,
    status: args.status,
    file: normalizedFile,
    requirement: { id: active.id, title: active.title, goal_key: active.goal_key ?? null },
    source_state_hash: originalSourceStateHash,
    source_content_hash: originalSourceStateHash,
    planner_fingerprint: persistedPlan.planner_fingerprint,
    current_state_hash: currentStateHash,
    plan: persistedPlan,
    progress: {
      modules,
      remaining_lines: actualRemainingLines,
      verification,
      verification_gaps: verificationGaps,
      updated_at: meta.updated_at,
    },
  }) ?? "{}";
  context.getDb().prepare(
    `UPDATE memory_items
        SET content = ?, metadata_json = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND kind = 'large_file_split_plan'`,
  ).run(content, safeJson(meta), sha256Hex(content), args.plan_id);
  logActivity("record_large_file_split", {
    plan_id: args.plan_id,
    req_id: active.id,
    file_path: normalizedFile,
    status: args.status,
    modules: modules.slice(0, 20),
    remaining_lines: actualRemainingLines,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          plan: { id: args.plan_id },
          note: { id: args.plan_id },
          linked_to_requirement: { id: active.id, title: active.title, goal_key: active.goal_key ?? null },
          file_path: normalizedFile,
          status: args.status,
          modules,
          remaining_lines: actualRemainingLines,
          verification,
          verification_gaps: verificationGaps,
        }),
      },
    ],
  };
}
