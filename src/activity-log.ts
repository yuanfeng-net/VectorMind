import { debugLogEnabled, debugLogMaxEntries } from "./config.js";

let getProjectRoot = (): string => "";

export function configureActivityLogProjectRoot(fn: () => string): void {
  getProjectRoot = fn;
}
type ActivityEvent = {
  id: number;
  ts: string;
  type: string;
  project_root: string;
  data: Record<string, unknown>;
};

let activitySeq = 0;
const activityLog: ActivityEvent[] = [];

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 20).map((v) => sanitizeForLog(v, depth + 1));
    return value.length > 20 ? [...sliced, `[+${value.length - 20} more]`] : sliced;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sanitizeForLog(obj[k], depth + 1);
    if (Object.keys(obj).length > 40) out["__more_keys__"] = Object.keys(obj).length - 40;
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

export function logActivity(type: string, data: Record<string, unknown>): void {
  if (!debugLogEnabled) return;
  activityLog.push({
    id: ++activitySeq,
    ts: new Date().toISOString(),
    type,
    project_root: getProjectRoot() || "",
    data: sanitizeForLog(data) as Record<string, unknown>,
  });
  while (activityLog.length > debugLogMaxEntries) activityLog.shift();
}

export function snapshotActivityLog(opts: { sinceId: number; limit: number }): { events: ActivityEvent[]; last_id: number } {
  const sinceId = Math.max(0, opts.sinceId);
  const limit = Math.max(1, Math.min(500, opts.limit));
  const lastId = activitySeq;
  const events = activityLog.filter((e) => e.id > sinceId).slice(0, limit);
  return { events, last_id: lastId };
}

export function clearActivityLog(): void {
  activityLog.length = 0;
  activitySeq = 0;
}

export function summarizeActivityEvent(e: ActivityEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "index_file":
      return `index ${String(d.file_path ?? "")} reason=${String(d.reason ?? "")} symbols=${String(
        d.symbols ?? "",
      )} chunks=${String(d.chunks ?? "")}`;
    case "remove_file":
      return `remove ${String(d.file_path ?? "")}`;
    case "pending_flush":
      return `pending_flush entries=${String(d.entries ?? "")}`;
    case "pending_prune":
      return `pending_prune ${String(d.before ?? "")}->${String(d.after ?? "")}`;
    case "bootstrap_context":
      return `bootstrap q=${String(d.query ?? "")} pending=${String(d.pending_returned ?? "")}/${String(
        d.pending_total ?? "",
      )} reqs=${String(d.requirements_returned ?? "")} semantic=${String(d.semantic_mode ?? "")}+${
        String(d.semantic_matches ?? "")
      }`;
    case "get_brain_dump":
      return `brain_dump pending=${String(d.pending_returned ?? "")}/${String(d.pending_total ?? "")} reqs=${String(
        d.requirements_returned ?? "",
      )} notes=${String(d.notes_returned ?? "")}`;
    case "get_pending_changes":
      return `pending_list returned=${String(d.returned ?? "")} total=${String(d.total ?? "")}`;
    case "semantic_search":
      return `semantic_search mode=${String(d.mode ?? "")} q=${String(d.query ?? "")} matches=${String(
        d.matches ?? "",
      )}`;
    case "grep":
      return `grep backend=${String(d.backend ?? "")} q=${String(d.query ?? "")} matches=${String(
        d.matches ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "query_codebase":
      return `query_codebase q=${String(d.query ?? "")} matches=${String(d.matches ?? "")}`;
    case "read_file_lines":
      return `read_file_lines file=${String(d.file_path ?? "")} returned=${String(d.returned ?? "")} truncated=${String(
        d.truncated ?? "",
      )}`;
    case "read_file_text":
      return `read_file_text file=${String(d.file_path ?? "")} returned=${String(d.returned_chars ?? "")}/${String(
        d.total_chars ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "list_project_files":
      return `list_project_files path=${String(d.path ?? "")} returned=${String(d.returned ?? "")} scanned=${String(
        d.scanned ?? "",
      )} truncated=${String(d.truncated ?? "")}`;
    case "read_codex_text_file":
      return `read_codex_text_file file=${String(d.file_path ?? "")} returned=${String(
        d.returned_chars ?? "",
      )}/${String(d.total_chars ?? "")} truncated=${String(d.truncated ?? "")}`;
    case "start_requirement":
      return `start_requirement #${String(d.req_id ?? "")} ${String(d.title ?? "")}`;
    case "sync_change_intent":
      return `sync_change_intent #${String(d.req_id ?? "")} files=${String(d.files_total ?? "")}`;
    case "complete_requirement":
      return `complete_requirement ${String(d.all_active ? "all_active" : d.req_id ?? "")}`;
    case "memory_maintenance":
      return `memory_maintenance trigger=${String(d.trigger ?? "")} compacted=${String(
        d.compacted ?? "",
      )} stale=${String(d.stale_files ?? "")} chunks_deleted=${String(d.chunks_deleted ?? "")}`;
    default:
      return e.type;
  }
}
