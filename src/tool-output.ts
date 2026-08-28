import type { PendingChangeRow, RootSource, SymbolRow } from "./types.js";
import type { LargeFileSplitPlan } from "./large-file-split.js";
import type { ProjectFileListEntry } from "./project-files.js";
import type { GrepBackend, GrepMatch } from "./grep.js";
import { prettyJsonOutput } from "./config.js";
type CompactDevelopmentWarning = {
  code: string;
  severity: string;
  message: string;
  files?: string[];
};

type CompactSecurityScan = {
  risk_level: string;
  untrusted_content?: boolean;
  advisory_only?: boolean;
  security_override_applied?: boolean;
  trusted_deployment_target_applied?: boolean;
  findings?: Array<{ code: string; severity: string; evidence?: string }>;
  coverage?: string;
  complete?: boolean;
  scanned_files?: number;
};

function compactSecurityScanText(scan: CompactSecurityScan): string {
  const files = scan.scanned_files == null ? "" : ` files=${scan.scanned_files}`;
  return `security scan risk=${scan.risk_level} advisory_only=${scan.advisory_only === true} override=${scan.security_override_applied === true} trusted_deployment_target=${scan.trusted_deployment_target_applied === true} coverage=${scan.coverage ?? "unknown"} complete=${scan.complete !== false}${files} findings=${(scan.findings ?? []).map((f) => `${f.severity}:${f.code}`).join(",")}`;
}

type CompactChangeMode = string;

type CompactRequirementScopeContract = {
  allow_terms: string[];
  deny_terms: string[];
  allowed_paths: string[];
  denied_paths: string[];
};

type CompactMemoryItemPreview = {
  id: number;
  kind: string;
  title?: string | null;
  file_path?: string | null;
  start_line?: number | null;
  preview?: string | null;
};

type CompactRequirementPreview = {
  id: number;
  title: string;
  status: string;
  memory_item_id?: number | null;
  context_preview?: string | null;
};

type CompactChangeLogPreview = {
  id: number;
  file_path: string | null;
  files?: string[];
  file_count?: number;
  intent_preview: string;
};

type CompactSemanticSearchResult = {
  query: string;
  top_k: number;
  mode: string;
  focused_fallback?: boolean;
  focused_no_match?: boolean;
  matches: Array<{ score: number; item: CompactMemoryItemPreview }>;
};

type CompactCurrentConstraint = {
  id: number;
  kind: string;
  title?: string | null;
  source: string;
  preview?: string | null;
};

type CompactOperationScopeWarning = {
  code: string;
  severity: string;
  message: string;
  evidence?: Array<{
    constraint_id: number;
    kind: string;
    title?: string | null;
    source: string;
    preview?: string | null;
  }>;
};

type CompactRelevantFixPattern = {
  memory_id: number;
  symptom: string;
  root_cause: string;
  invariant: string;
  avoid_regression?: string[];
  relevance_score: number;
  reason?: string;
};

type CompactQualitySignals = {
  advisory_only: boolean;
  does_not_control_model_reasoning?: boolean;
  does_not_control_host_runtime?: boolean;
  does_not_replace_model_judgment?: boolean;
  does_not_change_ok_or_safe_to_edit?: boolean;
  does_not_expand_requirement_scope?: boolean;
  relevant_fix_patterns?: CompactRelevantFixPattern[];
};

type CompactMaintenanceResult = {
  dry_run: boolean;
  trigger: string;
  db_size_before?: { total_bytes: number; db_bytes: number; wal_bytes: number; shm_bytes: number };
  db_size_after?: { total_bytes: number; db_bytes: number; wal_bytes: number; shm_bytes: number };
  compacted_memory: {
    candidates: number;
    compacted: number;
    archived: number;
    summary_memory_id: number | null;
    samples: Array<{ id: number; kind: string; title?: string | null; file_path?: string | null; updated_at: string }>;
  };
  pruned: {
    ignored_paths: { chunks_deleted: number; symbols_deleted: number };
    filename_noise: { chunks_deleted: number; symbols_deleted: number };
    stale_files: { chunks_deleted: number; symbols_deleted: number; samples: string[] };
  };
  pending_pruned?: { ignored_deleted: number; old_deleted: number; overflow_deleted: number };
  purged_hidden_memory?: {
    memory_candidates: number;
    memory_deleted: number;
    archive_candidates: number;
    archives_deleted: number;
    samples: Array<{ id: number; kind: string; title?: string | null; file_path?: string | null; updated_at: string }>;
  };
  metrics_pruned?: { token_savings_deleted: number; mcp_tool_metrics_deleted?: number };
  fts_optimized?: boolean;
  wal_checkpointed?: boolean;
  vacuumed?: boolean;
};

type CompactTokenSavingsSummary = {
  summary: { calls: number; raw_tokens: number; output_tokens: number; saved_tokens: number; avg_savings_pct: number };
  by_tool: Array<{ tool: string; calls: number; raw_tokens: number; output_tokens: number; saved_tokens: number; avg_savings_pct: number }>;
  recent: Array<{ id: number; tool: string; raw_tokens: number; output_tokens: number; saved_tokens: number; savings_pct: number; created_at: string }>;
};
function compactDevelopmentWarningsText(warnings: CompactDevelopmentWarning[]): string[] {
  if (!warnings.length) return [];
  const lines = ["development warnings:"];
  for (const w of warnings.slice(0, 8)) {
    const files = w.files?.length ? ` files=${w.files.slice(0, 5).join(",")}` : "";
    lines.push(`- ${w.severity} ${w.code}: ${oneLine(w.message, 180)}${files}`);
  }
  return lines;
}

function compactQualitySignalsText(signals?: CompactQualitySignals): string[] {
  const patterns = signals?.relevant_fix_patterns ?? [];
  if (!patterns.length) return [];
  const lines = [
    `quality signals advisory_only=${signals?.advisory_only === true} relevant_fix_patterns=${patterns.length}`,
  ];
  for (const p of patterns.slice(0, 3)) {
    lines.push(
      `- fix_pattern #${p.memory_id} score=${Number(p.relevance_score).toFixed(2)} invariant=${oneLine(p.invariant, 150)}`,
    );
    if (p.avoid_regression?.length) {
      lines.push(`  avoid: ${p.avoid_regression.slice(0, 2).map((item) => oneLine(item, 90)).join("; ")}`);
    }
  }
  lines.push("hint: fix_pattern matches are reminders only; do not expand scope or change ok/safe flags from them");
  return lines;
}

export function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function toolJson(value: unknown): string {
  return JSON.stringify(value, null, prettyJsonOutput ? 2 : undefined);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function oneLine(input: string | null | undefined, max = 120): string {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}
function compactMemoryLabel(item: CompactMemoryItemPreview, max = 120): string {
  const title = item.title ? ` ${oneLine(item.title, 48)}` : "";
  const loc = item.file_path ? ` ${item.file_path}${item.start_line != null ? `:${item.start_line}` : ""}` : "";
  const body = item.preview ? ` — ${oneLine(item.preview, max)}` : "";
  return `#${item.id} ${item.kind}${title}${loc}${body}`;
}
function compactRequirementLabel(req: CompactRequirementPreview): string {
  const ctx = req.context_preview ? ` — ${oneLine(req.context_preview, 100)}` : "";
  const mem = req.memory_item_id ? ` mem#${req.memory_item_id}` : "";
  return `req#${req.id}${mem} [${req.status}] ${oneLine(req.title, 80)}${ctx}`;
}
function compactChangeLabel(change: CompactChangeLogPreview): string {
  const files = change.files?.length
    ? `${change.files.slice(0, 3).join(",")}${change.files.length > 3 ? "..." : ""}`
    : (change.file_path ?? "unspecified");
  const count = change.file_count && change.file_count > 1 ? ` files=${change.file_count}` : "";
  return `change#${change.id}${count} ${files}: ${oneLine(change.intent_preview, 120)}`;
}
function compactPendingLabel(p: { file_path: string; last_event: string; updated_at: string }): string {
  const source = "source" in p && p.source === "git" ? " git" : "";
  const status = "git_status" in p && p.git_status ? ` ${p.git_status}` : "";
  return `${p.last_event}${source}${status} ${p.file_path}`;
}

export function compactSemanticSearchText(data: { ok?: boolean } & CompactSemanticSearchResult): string {
  const lines: string[] = [
    `semantic ${data.mode} ${data.matches.length}/${data.top_k} q="${oneLine(data.query, 100)}"`,
  ];
  if (data.focused_no_match) lines.push("confidence: no query-relevant memory passed focused relevance filtering; this is not proof that the fact was never stored or does not exist");
  for (const m of data.matches.slice(0, data.top_k)) {
    lines.push(`- score=${m.score.toFixed(3)} ${compactMemoryLabel(m.item, 160)}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  const scan = (data as typeof data & { security_scan?: CompactSecurityScan }).security_scan;
  if (scan?.findings?.length) lines.push(compactSecurityScanText(scan));
  lines.push("hint: use format=json for full metadata; read_memory_item(id) for full content");
  return lines.join("\n");
}

export function compactGrepText(data: {
  ok?: boolean;
  backend: GrepBackend;
  fallback_reason?: string;
  ripgrep_error?: string;
  query: string;
  mode: "regex" | "literal";
  matches: GrepMatch[];
  total_matches?: number;
  truncated: boolean;
  development_warnings?: CompactDevelopmentWarning[];
  candidates?: { total: number; scanned: number };
  security_scan?: CompactSecurityScan;
}): string {
  const total = data.total_matches ?? data.matches.length;
  const fallback = data.fallback_reason ? ` fallback=${data.fallback_reason}` : "";
  const candidateText = data.candidates ? ` candidates=${data.candidates.scanned}/${data.candidates.total}` : "";
  const lines = [
    `grep ${data.backend}${fallback} mode=${data.mode} matches=${data.matches.length}/${total} truncated=${data.truncated}${candidateText} q="${oneLine(data.query, 100)}"`,
  ];
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  if (data.security_scan?.findings?.length) lines.push(compactSecurityScanText(data.security_scan));
  if (data.ripgrep_error) lines.push(`ripgrep_error ${oneLine(data.ripgrep_error, 180)}`);
  for (const m of data.matches.slice(0, 80)) {
    lines.push(`${m.file_path}:${m.line}:${m.col}: ${oneLine(m.preview, 220)}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  if (data.truncated) lines.push("hint: refine query/include_paths or raise max_results; use format=json for full match objects");
  return lines.join("\n");
}

export function compactListProjectFilesText(data: {
  path: string;
  path_kind: string;
  recursive: boolean;
  max_depth: number;
  returned: number;
  scanned: number;
  truncated: boolean;
  entries: ProjectFileListEntry[];
}): string {
  const lines = [
    `files path=${data.path} kind=${data.path_kind} returned=${data.returned} scanned=${data.scanned} recursive=${data.recursive} depth=${data.max_depth} truncated=${data.truncated}`,
  ];
  for (const e of data.entries.slice(0, 200)) {
    const stat = e.size != null ? ` ${e.size}B` : "";
    lines.push(`${e.kind === "dir" ? "d" : "f"} ${e.path}${stat}`);
  }
  if (!data.entries.length) lines.push("- empty");
  if (data.truncated) lines.push("hint: narrow path/filters or raise max_results; use format=json for full entry metadata");
  return lines.join("\n");
}

export function compactReadTextFileText(data: {
  file_path: string;
  offset?: number;
  returned_chars: number;
  total_chars: number;
  truncated: boolean;
  development_warnings?: CompactDevelopmentWarning[];
  text: string;
  security_scan?: CompactSecurityScan;
}): string {
  const offset = data.offset != null ? ` offset=${data.offset}` : "";
  const header = `file ${data.file_path}${offset} chars=${data.returned_chars}/${data.total_chars} truncated=${data.truncated}`;
  const hint = data.truncated ? "\nhint: continue with offset or read_file_lines; use format=json for metadata fields" : "";
  const warnings = compactDevelopmentWarningsText(data.development_warnings ?? []).join("\n");
  const security = data.security_scan?.findings?.length ? `\n${compactSecurityScanText(data.security_scan)}` : "";
  return `${header}${warnings ? `\n${warnings}` : ""}${security}\n${data.text}${hint}`;
}

export function compactReadFileLinesText(data: {
  file_path: string;
  from_line: number;
  to_line: number;
  returned: number;
  truncated: boolean;
  development_warnings?: CompactDevelopmentWarning[];
  text: string;
  security_scan?: CompactSecurityScan;
}): string {
  const header = `lines ${data.file_path}:${data.from_line}-${data.to_line} returned=${data.returned} truncated=${data.truncated}`;
  const hint = data.truncated ? "\nhint: narrow range or raise max_lines/max_chars; use format=json for metadata fields" : "";
  const warnings = compactDevelopmentWarningsText(data.development_warnings ?? []).join("\n");
  const security = data.security_scan?.findings?.length ? `\n${compactSecurityScanText(data.security_scan)}` : "";
  return `${header}${warnings ? `\n${warnings}` : ""}${security}\n${data.text}${hint}`;
}

export function compactQueryCodebaseText(data: {
  query: string;
  matches: SymbolRow[];
  development_warnings?: CompactDevelopmentWarning[];
  security_scan?: CompactSecurityScan;
}): string {
  const lines = [`query_codebase matches=${data.matches.length} q="${oneLine(data.query, 100)}"`];
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  if (data.security_scan?.findings?.length) lines.push(compactSecurityScanText(data.security_scan));
  for (const m of data.matches.slice(0, 50)) {
    lines.push(`${m.file_path}: ${m.type} ${m.name}${m.signature ? ` — ${oneLine(m.signature, 160)}` : ""}`);
  }
  if (!data.matches.length) lines.push("- no matches");
  return lines.join("\n");
}

export function compactMaintenanceText(data: CompactMaintenanceResult): string {
  const prunedChunks =
    data.pruned.ignored_paths.chunks_deleted +
    data.pruned.filename_noise.chunks_deleted +
    data.pruned.stale_files.chunks_deleted;
  const prunedSymbols =
    data.pruned.ignored_paths.symbols_deleted +
    data.pruned.filename_noise.symbols_deleted +
    data.pruned.stale_files.symbols_deleted;
  const pendingPruned = data.pending_pruned
    ? data.pending_pruned.ignored_deleted + data.pending_pruned.old_deleted + data.pending_pruned.overflow_deleted
    : 0;
  const hiddenDeleted = data.purged_hidden_memory?.memory_deleted ?? 0;
  const archivesDeleted = data.purged_hidden_memory?.archives_deleted ?? 0;
  const tokenSavingsDeleted = data.metrics_pruned?.token_savings_deleted ?? 0;
  const toolMetricsDeleted = data.metrics_pruned?.mcp_tool_metrics_deleted ?? 0;
  const beforeBytes = data.db_size_before?.total_bytes ?? 0;
  const afterBytes = data.db_size_after?.total_bytes ?? 0;
  const lines = [
    `maintain_memory ok dry_run=${data.dry_run} trigger=${data.trigger} compacted=${data.compacted_memory.compacted}/${data.compacted_memory.candidates} archived=${data.compacted_memory.archived} pruned_chunks=${prunedChunks} pruned_symbols=${prunedSymbols} pending_pruned=${pendingPruned} hidden_deleted=${hiddenDeleted} archives_deleted=${archivesDeleted} token_savings_deleted=${tokenSavingsDeleted} mcp_tool_metrics_deleted=${toolMetricsDeleted}`,
  ];
  if (beforeBytes || afterBytes) {
    lines.push(`db_size total ${beforeBytes} -> ${afterBytes} bytes`);
  }
  if (data.compacted_memory.summary_memory_id) {
    lines.push(`summary memory_compaction #${data.compacted_memory.summary_memory_id}`);
  }
  if (data.compacted_memory.samples.length) {
    lines.push("memory candidates:");
    for (const s of data.compacted_memory.samples.slice(0, 8)) {
      lines.push(`- #${s.id} ${s.kind} ${s.file_path ?? ""} ${oneLine(s.title ?? "", 80)} ${s.updated_at}`);
    }
  }
  if (data.pruned.stale_files.samples.length) {
    lines.push("stale index samples:");
    for (const s of data.pruned.stale_files.samples.slice(0, 8)) lines.push(`- ${s}`);
  }
  if (data.purged_hidden_memory?.samples?.length) {
    lines.push("hidden memory purge candidates:");
    for (const s of data.purged_hidden_memory.samples.slice(0, 8)) {
      lines.push(`- #${s.id} ${s.kind} ${s.file_path ?? ""} ${oneLine(s.title ?? "", 80)} ${s.updated_at}`);
    }
  }
  if (data.fts_optimized || data.wal_checkpointed || data.vacuumed) {
    lines.push(`sqlite maintenance fts_optimized=${data.fts_optimized === true} wal_checkpointed=${data.wal_checkpointed === true} vacuumed=${data.vacuumed === true}`);
  }
  lines.push("hint: dry_run=false applies changes; vacuum=true reclaims sqlite file space after pruning");
  return lines.join("\n");
}

export function compactPreflightChangeScopeText(data: {
  ok: boolean;
  safe_to_edit: boolean;
  recommended_action: string;
  change_mode: CompactChangeMode;
  required_action?: string;
  allowed_change_modes?: CompactChangeMode[];
  active_requirement: { id: number; title: string } | null;
  intent: string;
  files: string[];
  requirement_mapping?: { requirement_items?: unknown[]; planned_changes?: unknown[] };
  scope_contract: CompactRequirementScopeContract | null;
  development_warnings: CompactDevelopmentWarning[];
  quality_signals?: CompactQualitySignals;
}): string {
  const req = data.active_requirement ? `#${data.active_requirement.id} ${data.active_requirement.title}` : "none";
  const lines = [
    `preflight_change_scope ok=${data.ok} safe_to_edit=${data.safe_to_edit} mode=${data.change_mode} requirement=${req} files=${data.files.length} intent="${oneLine(data.intent, 120)}"`,
    `action: ${oneLine(data.recommended_action, 180)}`,
  ];
  if (data.required_action) lines.push(`required_action=${data.required_action}`);
  if (data.allowed_change_modes?.length) lines.push(`allowed_change_modes=${data.allowed_change_modes.join(",")}`);
  if (data.requirement_mapping) {
    lines.push(
      `requirement_mapping items=${data.requirement_mapping.requirement_items?.length ?? 0} planned_changes=${data.requirement_mapping.planned_changes?.length ?? 0}`,
    );
  }
  if (data.scope_contract) {
    lines.push(
      `scope allow_terms=${data.scope_contract.allow_terms.length} deny_terms=${data.scope_contract.deny_terms.length} allowed_paths=${data.scope_contract.allowed_paths.length} denied_paths=${data.scope_contract.denied_paths.length}`,
    );
  }
  lines.push(...compactDevelopmentWarningsText(data.development_warnings));
  lines.push(...compactQualitySignalsText(data.quality_signals));
  if (!data.development_warnings.length) lines.push("- no development warnings");
  return lines.join("\n");
}

export function compactPreflightOperationScopeText(data: {
  ok: boolean;
  safe_to_proceed: boolean;
  advisory_only?: boolean;
  operation: string;
  intent: string;
  planned_commands: string[];
  planned_files: string[];
  planned_targets: string[];
  current_constraints: CompactCurrentConstraint[];
  warnings: CompactOperationScopeWarning[];
  recommended_action: string;
  enforcement_mode?: string;
  host_enforcement_required?: boolean;
  security_override_applied?: boolean;
  trusted_deployment_target_applied?: boolean;
}): string {
  const lines = [
    `preflight_operation_scope ok=${data.ok} safe_to_proceed=${data.safe_to_proceed} advisory_only=${data.advisory_only === true} enforcement=${data.enforcement_mode ?? "unknown"} host_enforcement_required=${data.host_enforcement_required === true} security_override_applied=${data.security_override_applied === true} trusted_deployment_target=${data.trusted_deployment_target_applied === true} operation="${oneLine(data.operation, 80)}" commands=${data.planned_commands.length} files=${data.planned_files.length} targets=${data.planned_targets.length}`,
    `action: ${oneLine(data.recommended_action, 200)}`,
  ];
  if (data.current_constraints.length) {
    lines.push("current_constraints:");
    for (const c of data.current_constraints.slice(0, 8)) {
      lines.push(`- #${c.id} ${c.source}/${c.kind} ${oneLine(c.title ?? "", 60)} —${oneLine(c.preview ?? "", 140)}`);
    }
  } else {
    lines.push("current_constraints: none");
  }
  if (data.warnings.length) {
    lines.push("operation warnings:");
    for (const w of data.warnings.slice(0, 8)) {
      const ev = w.evidence?.[0] ? ` evidence=#${w.evidence[0].constraint_id}` : "";
      lines.push(`- ${w.severity} ${w.code}${ev}: ${oneLine(w.message, 180)}`);
    }
  } else {
    lines.push("- no operation warnings");
  }
  return lines.join("\n");
}

export function compactLargeFileSplitPlanText(
  data: LargeFileSplitPlan & {
    plan_id?: number;
    plan_status?: string;
    requirement?: { id: number; title: string };
  },
): string {
  const lines = [
    `large_file_split ok=${data.ok} plan_id=${data.plan_id ?? ""} status=${data.plan_status ?? ""} file=${data.file_path} lines=${data.line_count} threshold=${data.huge_threshold_lines} action=${data.required_action}`,
    ...(data.requirement ? [`requirement=req#${data.requirement.id} ${oneLine(data.requirement.title, 90)}`] : []),
    `analysis=${data.analysis_mode} confidence=${data.confidence} coverage=${data.coverage.assigned_declarations}/${data.coverage.detected_declarations} complete=${data.coverage.complete}`,
    `module_constraints max_declarations=${data.module_constraints.max_declarations_per_module} max_lines=${data.module_constraints.max_estimated_lines_per_module} oversized=${data.module_constraints.oversized_modules.length} satisfied=${data.module_constraints.satisfied}`,
    `target_dir=${data.target_dir}`,
    `forbidden=${data.forbidden_patterns.join(",")}`,
  ];
  lines.push("modules:");
  for (const m of data.modules.slice(0, 20)) {
    const decls = m.declarations.length ? ` decls=${m.declarations.slice(0, 8).join("; ")}` : " decls=(manual sections)";
    const omitted = m.omitted_declarations ? ` samples_omitted=${m.omitted_declarations}` : "";
    lines.push(`- ${m.module} -> ${m.target_path} count=${m.declaration_count} estimated_lines=${m.estimated_lines}${omitted}${decls}`);
  }
  for (const warning of data.warnings.slice(0, 6)) lines.push(`warning: ${warning}`);
  lines.push("steps:");
  for (const step of data.steps.slice(0, 8)) lines.push(`- ${step}`);
  lines.push("validation:");
  for (const v of data.validation.slice(0, 8)) lines.push(`- ${v}`);
  lines.push("hint: use format=json for full declarations/rules");
  return lines.join("\n");
}

export function compactBootstrapText(data: {
  generated_at: string;
  project_root: string;
  root_source: RootSource;
  watcher_enabled: boolean;
  watcher_ready: boolean;
  index_state?: {
    watcher: string;
    fts_available: boolean;
    semantic_search: string;
  };
  context_policy?: {
    mode: "focused" | "full";
    include_pending: boolean;
    include_recent: boolean;
    max_output_chars: number;
    compact_truncated?: boolean;
  };
  recall_coverage?: {
    mode: "focused" | "full";
    filtered: boolean;
    memory_store_scope: "relevance_filtered" | "bounded_full";
    output_bounded: boolean;
    repository_covered: boolean;
    runtime_covered: boolean;
    recent_history_included: boolean;
    pending_changes_included: boolean;
    absence_interpretation: string;
    next_steps: string[];
  };
  operation_preflight?: {
    detected: boolean;
    required_before_commands: boolean;
    tool: string;
    bootstrap_is_not_operation_preflight: boolean;
    matched_terms: string[];
    action: string | null;
  };
  project_summary: CompactMemoryItemPreview | null;
  decisions: Array<CompactMemoryItemPreview>;
  conventions: Array<CompactMemoryItemPreview>;
  current_constraints?: Array<CompactCurrentConstraint>;
  current_context: Array<CompactMemoryItemPreview>;
  recent_notes: Array<CompactMemoryItemPreview>;
  pending_total: number;
  pending_included?: boolean;
  pending_offset: number;
  pending_limit: number;
  pending_truncated: boolean;
  pending_changes: PendingChangeRow[];
  development_warnings?: CompactDevelopmentWarning[];
  quality_signals?: CompactQualitySignals;
  items: Array<{
    requirement: CompactRequirementPreview;
    recent_changes: Array<CompactChangeLogPreview>;
  }>;
  recalled_context?: Array<{
    requirement: CompactRequirementPreview;
    recent_changes: Array<CompactChangeLogPreview>;
  }>;
  semantic?: CompactSemanticSearchResult | null;
  security_scan?: CompactSecurityScan;
}): string {
  const lines: string[] = [];
  lines.push(
    `ok ctx ${data.root_source} mode=${data.context_policy?.mode ?? "full"} watcher=${data.index_state?.watcher ?? (data.watcher_enabled ? (data.watcher_ready ? "ready" : "warming") : "off")} semantic=${data.index_state?.semantic_search ?? "unknown"} root=${data.project_root}`,
  );
  if (data.recall_coverage) {
    lines.push(`recall coverage store=${data.recall_coverage.memory_store_scope} bounded=${data.recall_coverage.output_bounded} repository=${data.recall_coverage.repository_covered} runtime=${data.recall_coverage.runtime_covered}; ${oneLine(data.recall_coverage.absence_interpretation, 220)}`);
  }
  if (data.project_summary) lines.push(`summary ${compactMemoryLabel(data.project_summary, 140)}`);
  if (data.operation_preflight?.required_before_commands) {
    lines.push(
      `operation preflight required tool=${data.operation_preflight.tool} matched=${data.operation_preflight.matched_terms.join(",") || "operation"}; bootstrap_context does not satisfy this step`,
    );
  }
  if (data.semantic) {
    lines.push(`semantic ${data.semantic.mode} ${data.semantic.matches.length}/${data.semantic.top_k} for "${oneLine(data.semantic.query, 80)}":`);
    if (data.semantic.focused_no_match) {
      lines.push("- no query-relevant memory passed focused filtering; non-exhaustive result, so inspect targeted memory, repository, or runtime before concluding absence");
    }
    for (const m of data.semantic.matches.slice(0, 5)) {
      lines.push(`- score=${m.score.toFixed(3)} ${compactMemoryLabel(m.item, 120)}`);
    }
  }
  if (data.decisions.length) {
    lines.push("current decisions:");
    for (const d of data.decisions.slice(0, 5)) lines.push(`- ${compactMemoryLabel(d, 160)}`);
  }
  if (data.current_constraints?.length) {
    lines.push("current constraints:");
    for (const c of data.current_constraints.slice(0, 6)) {
      lines.push(`- #${c.id} ${c.source}/${c.kind} ${oneLine(c.title ?? "", 54)} —${oneLine(c.preview ?? "", 130)}`);
    }
  }
  if (data.current_context.length) {
    lines.push("current context:");
    for (const c of data.current_context.slice(0, 8)) lines.push(`- ${compactMemoryLabel(c, 160)}`);
  }
  if (data.pending_included === false) {
    if (data.pending_total) lines.push(`pending omitted total=${data.pending_total}; call get_pending_changes only before sync or when diagnosing scope`);
  } else if (data.pending_total) {
    lines.push(
      `pending ${data.pending_changes.length}/${data.pending_total}${data.pending_truncated ? " truncated" : ""}: ${data.pending_changes
        .slice(0, 8)
        .map(compactPendingLabel)
        .join("; ")}`,
    );
  } else {
    lines.push("pending 0");
  }
  lines.push(...compactDevelopmentWarningsText(data.development_warnings ?? []));
  if (data.security_scan?.findings?.length) lines.push(compactSecurityScanText(data.security_scan));
  lines.push(...compactQualitySignalsText(data.quality_signals));
  if (data.items.length) {
    lines.push("requirements:");
    for (const item of data.items) {
      lines.push(`- ${compactRequirementLabel(item.requirement)}`);
      for (const c of item.recent_changes.slice(0, 3)) lines.push(`  - ${compactChangeLabel(c)}`);
    }
  } else if (data.context_policy?.include_recent !== false) {
    lines.push("requirements: none");
  }
  if (data.recalled_context?.length) {
    lines.push("recalled context:");
    for (const item of data.recalled_context) {
      lines.push(`- ${compactRequirementLabel(item.requirement)}`);
      for (const c of item.recent_changes.slice(0, 3)) lines.push(`  - ${compactChangeLabel(c)}`);
    }
  }
  if (data.recent_notes.length) {
    lines.push("notes:");
    for (const n of data.recent_notes.slice(0, 3)) lines.push(`- ${compactMemoryLabel(n, 120)}`);
  }
  if (data.conventions.length) {
    lines.push(
      `conventions ${data.conventions.length}: ${data.conventions
        .slice(0, 5)
        .map((c) => c.title ?? `#${c.id}`)
        .join(", ")}`,
    );
  }
  lines.push("hint: use format=json for full structured output; read_memory_item(id) for full content");
  return lines.join("\n");
}

export function compactBrainDumpText(data: Parameters<typeof compactBootstrapText>[0]): string {
  return compactBootstrapText(data);
}

export function compactTokenSavingsText(data: CompactTokenSavingsSummary): string {
  const s = data.summary;
  const pct = Number(s.raw_tokens) > 0 ? (Number(s.saved_tokens) / Number(s.raw_tokens)) * 100 : 0;
  const lines = [
    `token_savings calls=${s.calls} raw=${s.raw_tokens} out=${s.output_tokens} saved=${s.saved_tokens} (${pct.toFixed(1)}%)`,
  ];
  if (data.by_tool.length) {
    lines.push("by_tool:");
    for (const t of data.by_tool.slice(0, 10)) {
      lines.push(
        `- ${t.tool}: calls=${t.calls} saved=${t.saved_tokens} raw=${t.raw_tokens} out=${t.output_tokens} avg=${Number(
          t.avg_savings_pct,
        ).toFixed(1)}%`,
      );
    }
  }
  if (data.recent.length) {
    lines.push("recent:");
    for (const r of data.recent.slice(0, 10)) {
      lines.push(`- #${r.id} ${r.tool}: ${r.raw_tokens}->${r.output_tokens} saved=${r.saved_tokens}`);
    }
  }
  return lines.join("\n");
}

export function sliceTextForOutput(
  input: string,
  maxChars: number,
): { text: string; truncated: boolean; total_chars: number } {
  const total = input.length;
  if (maxChars <= 0) return { text: input, truncated: false, total_chars: total };
  if (total <= maxChars) return { text: input, truncated: false, total_chars: total };
  return { text: input.slice(0, maxChars), truncated: true, total_chars: total };
}
