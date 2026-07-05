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
import { BOOTSTRAP_DEFAULT_CONTEXT_KINDS, getConventionPreviews, getCurrentContextPreviews, getDecisionPreviews, isHiddenFromDefaultRecall, semanticSearchHybridInternal, toChangeLogPreview, toMemoryItemPreview, toRequirementPreview } from "../memory-recall.js";
import { logActivity } from "../activity-log.js";
import { compactBootstrapText, compactBrainDumpText, compactSemanticSearchText, toolJson } from "../tool-output.js";
function getVisibleRecentNotePreviews(
  listRecentNotesStmt: Database.Statement,
  limit: number,
  includeContent: boolean,
  previewChars: number,
  contentMaxChars: number,
) {
  if (limit <= 0) return [];
  const fetchLimit = Math.max(limit, Math.min(200, limit * 4));
  return (listRecentNotesStmt.all(fetchLimit) as MemoryItemRow[])
    .filter((n) => !isHiddenFromDefaultRecall(n))
    .slice(0, limit)
    .map((n) => toMemoryItemPreview(n, includeContent, previewChars, contentMaxChars));
}

export async function handleBootstrapContext(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const rootSource = context.getRootSource();
  const dbPath = context.getDbPath();
  const watcherEnabled = context.isWatcherEnabled();
  const watcherReady = context.isWatcherReady();
  const {
    getActiveRequirementStmt,
    listPendingChangesStmt,
    getProjectSummaryStmt,
    listRecentRequirementsStmt,
    listChangeLogsForRequirementStmt,
    listRecentNotesStmt,
  } = context.getStatements();

  const args = BootstrapContextArgsSchema.parse(rawArgs);
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
    listRecentNotesStmt,
    notesLimit,
    includeContent,
    previewChars,
    contentMaxChars,
  );
  const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
  const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
  const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
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

  const q = args.query?.trim() ?? "";
  const semanticKinds = args.kinds?.length ? args.kinds : BOOTSTRAP_DEFAULT_CONTEXT_KINDS;
  const semantic =
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
    items,
    semantic,
  };

  return {
    content: [
      {
        type: "text",
        text: toolText("bootstrap_context", outputValue, compactBootstrapText(outputValue), args.format),
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
  const watcherEnabled = context.isWatcherEnabled();
  const watcherReady = context.isWatcherReady();
  const {
    getActiveRequirementStmt,
    listPendingChangesStmt,
    getProjectSummaryStmt,
    listRecentRequirementsStmt,
    listChangeLogsForRequirementStmt,
    listRecentNotesStmt,
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
    listRecentNotesStmt,
    notesLimit,
    includeContent,
    previewChars,
    contentMaxChars,
  );
  const decisions = getDecisionPreviews(decisionsLimit, previewChars, contentMaxChars);
  const conventions = getConventionPreviews(conventionsLimit, previewChars, contentMaxChars);
  const current_context = getCurrentContextPreviews(currentContextLimit, previewChars, contentMaxChars);
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
    items,
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
