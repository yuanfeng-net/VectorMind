import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

import type { ToolHandlerContext } from "./context.js";
import type { ChangeLogRow, MemoryItemRow, RequirementRow } from "../types.js";
import { BOOTSTRAP_SEMANTIC_TIMEOUT_MS } from "../config.js";
import { BootstrapContextArgsSchema, GetBrainDumpArgsSchema, ReadMemoryItemArgsSchema, SemanticSearchArgsSchema } from "../tool-schemas.js";
import { buildDevelopmentWarnings, buildScopeDriftWarnings } from "../development-warnings.js";
import { mergePendingWithGit } from "../pending-changes.js";
import { toolCompactOrJson, toolText } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { buildFixPatternQualitySignals, collectRelevantFixPatterns } from "../fix-patterns.js";
import { BOOTSTRAP_DEFAULT_CONTEXT_KINDS, getConventionPreviews, getCurrentContextPreviews, getDecisionPreviews, isHiddenFromDefaultRecall, metadataStatus, semanticSearchHybridInternal, toChangeLogPreview, toMemoryItemPreview, toRequirementPreview } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { compactBootstrapText, compactBrainDumpText, compactSemanticSearchText, toolJson } from "../tool-output.js";
import { collectCurrentConstraintsForBootstrap } from "./operations.js";
import {
  boundCompactContext,
  filterFocusedSemanticResult,
  resolveBootstrapContextPolicy,
} from "../context-governance.js";
function getVisibleRecentNotePreviews(
  db: Database.Database,
  limit: number,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
) {
  if (limit <= 0) return [];
  const pageSize = 200;
  const scanCap = 10_000;
  const listVisibleNotesPageStmt = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
     FROM memory_items
     WHERE kind = 'note'
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  let visible: MemoryItemRow[] = [];
  let offset = 0;
  while (true) {
    const rows = listVisibleNotesPageStmt.all(pageSize, offset) as MemoryItemRow[];
    if (!rows.length) break;
    for (const n of rows) {
      if (!isHiddenFromDefaultRecall(n)) visible.push(n);
      if (visible.length >= limit) break;
    }
    offset += rows.length;
    if (visible.length >= limit || rows.length < pageSize || offset >= scanCap) break;
  }
  return visible
    .slice(0, limit)
    .map((n) => toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars));
}

function getActiveLargeFilePlanPreviews(
  db: Database.Database,
  reqId: number,
  limit: number,
  previewChars: number,
  contentMaxChars: number,
) {
  if (limit <= 0) return [];
  const rows = db.prepare(
    `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, content_hash, created_at, updated_at
       FROM memory_items
      WHERE kind = 'large_file_split_plan'
        AND req_id = ?
        AND COALESCE(json_extract(
          CASE WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}') ELSE '{}' END,
          '$.status'
        ), '') NOT IN ('resolved', 'superseded', 'compacted', 'deferred', 'abandoned')
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`,
  ).all(reqId, limit) as MemoryItemRow[];
  return rows.map((row) => toMemoryItemPreview(row, false, previewChars, contentMaxChars));
}

export async function handleBootstrapContext(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const rootSource = context.getRootSource();
  const dbPath = context.getDbPath();
  const db = context.getDb();
  const watcherEnabled = context.isWatcherEnabled();
  const watcherReady = context.isWatcherReady();
  const {
    getActiveRequirementStmt,
    listPendingChangesStmt,
    getProjectSummaryStmt,
    listRecentRequirementsStmt,
    listChangeLogsForRequirementStmt,
  } = context.getStatements();

  const args = BootstrapContextArgsSchema.parse(rawArgs);
  const contextPolicy = resolveBootstrapContextPolicy(rawArgs, args);
  flushPendingChangeBuffer();

  const previewChars = args.preview_chars;
  const includeContent = args.include_content;
  const contentMaxChars = args.content_max_chars;
  const requirementsLimit = args.requirements_limit;
  const changesLimit = args.changes_limit;
  const notesLimit = args.notes_limit;
  const conventionsLimit = args.conventions_limit;
  const decisionsLimit = args.decisions_limit;
  const currentContextLimit = args.current_context_limit;

  const activeRequirement = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const recent = contextPolicy.include_recent
    ? listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[]
    : activeRequirement
      ? [activeRequirement]
      : [];
  let items = recent.map((req) => {
    const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
    return {
      requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
      recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
    };
  });
  const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
  const project_summary = projectSummaryRow
    ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
    : null;
  let recent_notes = contextPolicy.include_recent
    ? getVisibleRecentNotePreviews(db, notesLimit, includeContent, previewChars, contentMaxChars)
    : [];
  let decisions = getDecisionPreviews(
    contextPolicy.include_recent ? decisionsLimit : Math.min(3, decisionsLimit),
    previewChars,
    contentMaxChars,
  );
  const conventions = contextPolicy.include_recent
    ? getConventionPreviews(conventionsLimit, previewChars, contentMaxChars)
    : [];
  let current_context = contextPolicy.include_recent
    ? getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars)
    : activeRequirement
      ? getActiveLargeFilePlanPreviews(db, activeRequirement.id, Math.min(3, currentContextLimit), previewChars, contentMaxChars)
      : [];
  let current_constraints = collectCurrentConstraintsForBootstrap(
    context,
    contextPolicy.include_recent
      ? Math.max(8, Math.min(20, currentContextLimit + decisionsLimit))
      : 8,
    previewChars,
  );
  const activeForScope = activeRequirement;
  const relevantFixPatterns = collectRelevantFixPatterns(context, {
    intent: args.query ?? "",
    files: [],
    requirement: activeForScope ?? null,
    limit: 3,
  });
  const quality_signals = buildFixPatternQualitySignals(relevantFixPatterns);
  const pending_offset = args.pending_offset;
  const pending_limit = args.pending_limit;
  const mergedPending = contextPolicy.include_pending
    ? mergePendingWithGit(
        listPendingChangesStmt.all() as Array<{
          file_path: string;
          last_event: string;
          updated_at: string;
        }>,
        { offset: pending_offset, limit: pending_limit },
      )
    : { total: 0, truncated: false, page: [] };
  const pending_total = mergedPending.total;
  let pending_truncated = mergedPending.truncated;
  let pending_changes = mergedPending.page;
  let development_warnings = [
    ...buildDevelopmentWarnings(pending_changes),
    ...(activeForScope
      ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending_changes })
      : []),
  ];

  const q = args.query?.trim() ?? "";
  const semanticKinds = args.kinds?.length ? args.kinds : BOOTSTRAP_DEFAULT_CONTEXT_KINDS;
  const semanticRaw =
    q
      ? await Promise.race([
          semanticSearchHybridInternal({
            query: q,
            topK: args.top_k,
            kinds: semanticKinds,
            includeContent,
            previewChars,
            contentMaxChars,
          }),
          new Promise<null>((resolve) => setTimeout(resolve, BOOTSTRAP_SEMANTIC_TIMEOUT_MS, null)),
        ]).catch((err) => {
          console.error("[vectormind] bootstrap semantic_search failed:", err);
          return null;
        })
      : null;
  const semanticWithoutInactiveDefaultPlans = semanticRaw && !args.kinds?.length
    ? {
        ...semanticRaw,
        matches: semanticRaw.matches.filter((match) =>
          match.item.kind !== "large_file_split_plan" ||
          !["resolved", "deferred", "abandoned"].includes(metadataStatus(match.item))
        ),
      }
    : semanticRaw;
  const semantic = contextPolicy.mode === "focused"
    ? filterFocusedSemanticResult(q, semanticWithoutInactiveDefaultPlans)
    : semanticWithoutInactiveDefaultPlans;

  if (!contextPolicy.include_pending) {
    pending_changes = [];
    pending_truncated = pending_total > 0;
    development_warnings = [];
  }

  logActivity("bootstrap_context", {
    query: q || null,
    pending_total,
    pending_returned: pending_changes.length,
    requirements_returned: items.length,
    decisions_returned: decisions.length,
    current_context_returned: current_context.length,
    conventions_returned: conventions.length,
    semantic_mode: semantic?.mode ?? null,
    semantic_matches: semantic?.matches?.length ?? 0,
    context_mode: contextPolicy.mode,
    pending_included: contextPolicy.include_pending,
    recent_included: contextPolicy.include_recent,
  });

  const outputValue = {
    ok: true,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    root_source: rootSource,
    db_path: dbPath,
    watcher_enabled: watcherEnabled,
    watcher_ready: watcherReady,
    context_policy: {
      mode: contextPolicy.mode,
      include_pending: contextPolicy.include_pending,
      include_recent: contextPolicy.include_recent,
      max_output_chars: contextPolicy.max_output_chars,
      compact_truncated: false,
      current_anchor_included: items.length > 0,
    },
    output: {
      format: args.format,
      include_content: includeContent,
      preview_chars: previewChars,
      content_max_chars: contentMaxChars,
      requirements_limit: requirementsLimit,
      changes_limit: changesLimit,
      notes_limit: notesLimit,
      decisions_limit: decisionsLimit,
      current_context_limit: currentContextLimit,
      conventions_limit: conventionsLimit,
    },
    project_summary,
    decisions,
    conventions,
    current_context,
    recent_notes,
    pending_total,
    pending_included: contextPolicy.include_pending,
    pending_offset,
    pending_limit,
    pending_truncated,
    pending_changes,
    development_warnings,
    quality_signals,
    items,
    current_constraints,
    semantic,
  };

  const compactOutput = boundCompactContext(
    compactBootstrapText(outputValue),
    contextPolicy.max_output_chars,
  );
  outputValue.context_policy = {
    ...outputValue.context_policy,
    compact_truncated: compactOutput.truncated,
  };

  return {
    content: [
      {
        type: "text",
        text: toolText("bootstrap_context", outputValue, compactOutput.text, args.format),
      },
    ],
  };
}
export async function handleGetBrainDump(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const rootSource = context.getRootSource();
  const dbPath = context.getDbPath();
  const db = context.getDb();
  const watcherEnabled = context.isWatcherEnabled();
  const watcherReady = context.isWatcherReady();
  const {
    getActiveRequirementStmt,
    listPendingChangesStmt,
    getProjectSummaryStmt,
    listRecentRequirementsStmt,
    listChangeLogsForRequirementStmt,
  } = context.getStatements();

  const args = GetBrainDumpArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const previewChars = args.preview_chars;
  const includeContent = args.include_content;
  const contentMaxChars = args.content_max_chars;
  const requirementsLimit = args.requirements_limit;
  const changesLimit = args.changes_limit;
  const notesLimit = args.notes_limit;
  const conventionsLimit = args.conventions_limit;
  const decisionsLimit = args.decisions_limit;
  const currentContextLimit = args.current_context_limit;

  const recent = listRecentRequirementsStmt.all(requirementsLimit) as RequirementRow[];
  const items = recent.map((req) => {
    const changes = listChangeLogsForRequirementStmt.all(req.id, changesLimit) as ChangeLogRow[];
    return {
      requirement: toRequirementPreview(req, includeContent, previewChars, contentMaxChars),
      recent_changes: changes.map((c) => toChangeLogPreview(c, includeContent, previewChars, contentMaxChars)),
    };
  });
  const projectSummaryRow = getProjectSummaryStmt.get() as MemoryItemRow | undefined;
  const project_summary = projectSummaryRow
    ? toMemoryItemPreview(projectSummaryRow, includeContent, previewChars, contentMaxChars)
    : null;
  const recent_notes = getVisibleRecentNotePreviews(
    db,
    notesLimit,
    includeContent,
    previewChars,
    contentMaxChars,
  );
  const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
  const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
  const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
  const current_constraints = collectCurrentConstraintsForBootstrap(context, Math.max(8, Math.min(20, currentContextLimit + decisionsLimit)), previewChars);
  const quality_signals = buildFixPatternQualitySignals([]);
  const pending_offset = args.pending_offset;
  const pending_limit = args.pending_limit;
  const pendingDbRows = listPendingChangesStmt.all() as Array<{
    file_path: string;
    last_event: string;
    updated_at: string;
  }>;
  const mergedPending = mergePendingWithGit(pendingDbRows, { offset: pending_offset, limit: pending_limit });
  const pending_total = mergedPending.total;
  const pending_truncated = mergedPending.truncated;
  const pending_changes = mergedPending.page;
  const activeForScope = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const development_warnings = [
    ...buildDevelopmentWarnings(pending_changes),
    ...(activeForScope
      ? buildScopeDriftWarnings({ requirement: activeForScope, files: pending_changes })
      : []),
  ];

  logActivity("get_brain_dump", {
    pending_total,
    pending_returned: pending_changes.length,
    requirements_returned: items.length,
    notes_returned: recent_notes.length,
    decisions_returned: decisions.length,
    current_context_returned: current_context.length,
    conventions_returned: conventions.length,
  });

  const outputValue = {
    ok: true,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    root_source: rootSource,
    db_path: dbPath,
    watcher_enabled: watcherEnabled,
    watcher_ready: watcherReady,
    output: {
      format: args.format,
      include_content: includeContent,
      preview_chars: previewChars,
      content_max_chars: contentMaxChars,
      requirements_limit: requirementsLimit,
      changes_limit: changesLimit,
      notes_limit: notesLimit,
      decisions_limit: decisionsLimit,
      current_context_limit: currentContextLimit,
      conventions_limit: conventionsLimit,
    },
    project_summary,
    decisions,
    conventions,
    current_context,
    recent_notes,
    pending_total,
    pending_offset,
    pending_limit,
    pending_truncated,
    pending_changes,
    development_warnings,
    quality_signals,
    items,
    current_constraints,
    semantic: null,
  };

  return {
    content: [
      {
        type: "text",
        text: toolText("get_brain_dump", outputValue, compactBrainDumpText(outputValue), args.format),
      },
    ],
  };
}
export async function handleReadMemoryItem(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const { getMemoryItemByIdStmt } = context.getStatements();

  const args = ReadMemoryItemArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const row = getMemoryItemByIdStmt.get(args.id) as MemoryItemRow | undefined;
  if (!row) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not found" }) }] };
  }

  const total = row.content.length;
  const offset = args.offset;
  const limit = args.limit;
  const chunk = row.content.slice(offset, offset + limit);
  const truncated = offset + limit < total;

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          item: {
            id: row.id,
            kind: row.kind,
            title: row.title,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            req_id: row.req_id,
            metadata_json: row.metadata_json,
            updated_at: row.updated_at,
          },
          total_chars: total,
          offset,
          limit,
          truncated,
          content: chunk,
        }),
      },
    ],
  };
}
export async function handleSemanticSearch(
  rawArgs: Record<string, unknown>,
  _context: ToolHandlerContext,
): Promise<CallToolResult> {
  const args = SemanticSearchArgsSchema.parse(rawArgs);
  const result = await semanticSearchHybridInternal({
    query: args.query,
    topK: args.top_k,
    kinds: args.kinds?.length ? args.kinds : null,
    includeContent: args.include_content,
    previewChars: args.preview_chars,
    contentMaxChars: args.content_max_chars,
  });

  logActivity("semantic_search", {
    query: result.query,
    mode: result.mode,
    top_k: result.top_k,
    matches: result.matches.length,
    sample: result.matches.slice(0, 10).map((m) => ({
      id: m.item.id,
      kind: m.item.kind,
      file_path: m.item.file_path,
      score: m.score,
    })),
  });

  const outputValue = { ok: true, ...result };

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("semantic_search", outputValue, compactSemanticSearchText(outputValue), args.format),
      },
    ],
  };
}
