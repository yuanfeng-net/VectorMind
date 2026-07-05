import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { RequirementRow } from "../types.js";
import type { ChangeMode } from "../development-warnings.js";
import { CompleteRequirementArgsSchema, GetPendingChangesArgsSchema, MAX_PENDING_LIMIT, PreflightChangeScopeArgsSchema, StartRequirementArgsSchema, SyncChangeIntentArgsSchema } from "../tool-schemas.js";
import { buildDevelopmentWarnings, buildRequirementScopeContract, buildRequirementStartWarnings, buildScopeDriftWarnings, getRequirementScopeContract, isDevelopmentWarningBlockingForChangeMode, mergeScopeContracts } from "../development-warnings.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer, indexFile } from "../file-indexing.js";
import { completeAllActiveRequirementMemoryItems, completeRequirementMemoryItemsByReqId } from "../memory-mutations.js";
import { makePreviewText } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { compactPreflightChangeScopeText, safeJson, toolJson } from "../tool-output.js";
export async function handleStartRequirement(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const sha256Hex = context.sha256Hex;
  const { insertRequirementStmt, completeAllActiveRequirementsStmt, insertMemoryItemStmt } = context.getStatements();

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
  const development_warnings = buildRequirementStartWarnings({
    title: args.title,
    background: args.background,
    close_previous: args.close_previous,
  });

  if (args.close_previous) {
    try {
      completeAllActiveRequirementsStmt.run();
      completeAllActiveRequirementMemoryItems();
    } catch (err) {
      console.error("[vectormind] failed to close previous active requirements:", err);
    }
  }

  const info = insertRequirementStmt.run(args.title, args.background || null);
  const id = Number(info.lastInsertRowid);

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
    safeJson({ status: "active", scope_contract }),
    sha256Hex(content),
  );
  const memory_id = Number(memoryInfo.lastInsertRowid);

  logActivity("start_requirement", {
    req_id: id,
    title: args.title,
    closed_previous: args.close_previous,
    scope_contract,
    development_warnings: development_warnings.length,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          requirement: { id, title: args.title },
          memory_item: { id: memory_id },
          closed_previous: args.close_previous,
          scope_contract,
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
  const { getActiveRequirementStmt } = context.getStatements();

  const args = PreflightChangeScopeArgsSchema.parse(rawArgs);
  const changeMode = args.change_mode as ChangeMode;
  flushPendingChangeBuffer();
  const files = (args.files ?? args.planned_files ?? []).filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const explicitContract = buildRequirementScopeContract({
    title: active?.title ?? "",
    background: active?.context_data ?? "",
    scope_allow: args.scope_allow,
    scope_deny: args.scope_deny,
    allowed_paths: args.allowed_paths,
    denied_paths: args.denied_paths,
  });
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
  const blockingWarnings = development_warnings.filter((w) =>
    isDevelopmentWarningBlockingForChangeMode(w, changeMode),
  );
  const hasBlockingWarnings = blockingWarnings.length > 0;
  const safeToEdit = hasTargetFiles && !hasBlockingWarnings;
  const recommendedAction = !hasTargetFiles
    ? "Identify the intended target files/modules and rerun preflight_change_scope before editing."
    : hasHugeFile && changeMode === "mechanical_modularization" && safeToEdit
      ? "Proceed only with mechanical modularization: call plan_large_file_split, move whole declarations into real named modules/directories, avoid generated/parts files, validate, then record_large_file_split."
      : hasHugeFile && changeMode === "emergency_hotfix" && safeToEdit
        ? "Proceed only with the smallest urgent fix, do not add new responsibilities, record why mechanical modularization was deferred, and plan/record the split next."
        : hasHugeFile
          ? "Stop normal feature work. Call plan_large_file_split and perform mechanical modularization first, or rerun preflight_change_scope with change_mode='mechanical_modularization' for the split itself."
          : hasBlockingWarnings
            ? "Stop before editing. Narrow the planned files or explicitly expand the current requirement/scope contract."
            : "Planned files are within the current generic scope checks.";
  const requiredAction = hasHugeFile && changeMode !== "mechanical_modularization"
    ? "mechanical_modularization"
    : undefined;
  const allowedChangeModes = hasHugeFile
    ? (["mechanical_modularization", "emergency_hotfix"] as ChangeMode[])
    : undefined;

  const outputValue = {
    ok: safeToEdit,
    safe_to_edit: safeToEdit,
    change_mode: changeMode,
    recommended_action: recommendedAction,
    required_action: requiredAction,
    allowed_change_modes: allowedChangeModes,
    active_requirement: active ? { id: active.id, title: active.title } : null,
    intent: args.intent,
    files: files.map(normalizeToDbPath),
    scope_contract,
    development_warnings,
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
    insertMemoryItemStmt,
    getActiveRequirementStmt,
    listPendingChangesStmt,
    deletePendingChangeStmt,
    deleteAllPendingChangesStmt,
  } = context.getStatements();

  const args = SyncChangeIntentArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const explicitFiles = (args.files ?? args.affected_files ?? []).filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
  if (!active) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error:
              "No active requirement. Call start_requirement({ project_root, title, background }) before syncing change intent.",
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

    for (const t of targets) {
      const isUnspecified = t.dbFilePath === "(unspecified)";
      const changeInfo = insertChangeLogStmt.run(active.id, t.dbFilePath, args.intent);
      const change_log_id = Number(changeInfo.lastInsertRowid);

      const memoryInfo = insertMemoryItemStmt.run(
        "change_intent",
        active.title,
        args.intent,
        isUnspecified ? null : t.dbFilePath,
        null,
        null,
        active.id,
        safeJson({
          change_log_id,
          event: t.event,
          source: t.source,
          file_state_hash: isUnspecified ? null : getFileStateHash(t.rawFile),
        }),
        sha256Hex(args.intent),
      );
      const memory_item_id = Number(memoryInfo.lastInsertRowid);

      synced_files.push({ file_path: t.dbFilePath, event: t.event, source: t.source });
      created.push({
        file_path: t.dbFilePath,
        event: t.event,
        source: t.source,
        change_log_id,
        memory_item_id,
      });

      if (!isUnspecified && t.event !== "unlink") {
        const abs = path.isAbsolute(t.rawFile)
          ? t.rawFile
          : path.join(projectRoot, t.rawFile);
        indexFile(abs, "manual");
      }
    }
  });
  insertTx();
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
    development_warnings: development_warnings.length,
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
  const { getActiveRequirementStmt, listPendingChangesStmt } = context.getStatements();

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
  const activeForScope = getActiveRequirementStmt.get() as RequirementRow | undefined;
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
        text: toolJson({ ok: true, total, offset, limit, truncated, pending, development_warnings }),
      },
    ],
  };
}
export async function handleCompleteRequirement(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const db = context.getDb();
  const { completeAllActiveRequirementsStmt, getActiveRequirementStmt, completeRequirementByIdStmt } = context.getStatements();

  const args = CompleteRequirementArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();

  const updated: Array<{ id: number }> = [];
  if (args.all_active) {
    const activeRows = (db.prepare(
      `SELECT id FROM requirements WHERE status = 'active' ORDER BY created_at DESC, id DESC`,
    ).all() as Array<{ id: number }>).slice(0, 200);

    try {
      completeAllActiveRequirementsStmt.run();
      completeAllActiveRequirementMemoryItems();
    } catch (err) {
      console.error("[vectormind] complete all active requirements failed:", err);
    }

    for (const r of activeRows) updated.push({ id: r.id });
    logActivity("complete_requirement", { all_active: true, completed: updated.map((u) => u.id) });
    return { content: [{ type: "text", text: toolJson({ ok: true, completed: updated }) }] };
  }

  const targetId =
    args.req_id ?? (getActiveRequirementStmt.get() as RequirementRow | undefined)?.id ?? null;
  if (!targetId) {
    return { content: [{ type: "text", text: toolJson({ ok: true, completed: [] }) }] };
  }

  try {
    completeRequirementByIdStmt.run(targetId);
    completeRequirementMemoryItemsByReqId(targetId);
  } catch (err) {
    console.error("[vectormind] complete requirement failed:", err);
  }

  logActivity("complete_requirement", { req_id: targetId });
  return { content: [{ type: "text", text: toolJson({ ok: true, completed: [{ id: targetId }] }) }] };
}
