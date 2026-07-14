export type RequirementRow = {
  id: number;
  title: string;
  status: string;
  context_data: string | null;
  goal_key?: string | null;
  created_at: string;
};

export type ChangeLogRow = {
  id: number;
  req_id: number;
  file_path: string | null;
  intent_summary: string;
  files_json?: string | null;
  file_count?: number | null;
  timestamp: string;
};

export type SyncedFileStateRow = {
  file_path: string;
  file_state_hash: string | null;
  source_change_id: number | null;
  updated_at: string;
};

export type SymbolRow = {
  name: string;
  type: string;
  file_path: string;
  signature: string | null;
};

export type MemoryItemRow = {
  id: number;
  kind: string;
  title: string | null;
  content: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  req_id: number | null;
  metadata_json: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
};

export type PendingChangeRow = {
  file_path: string;
  last_event: string;
  updated_at: string;
  source?: "watcher" | "git";
  git_status?: string;
  file_state_hash?: string;
};

export type ExtractedSymbol = {
  name: string;
  type: string;
  signature: string;
};

export type RtkDetection = {
  available: boolean;
  version?: string;
  command: string;
  note: string;
  gain_ok?: boolean;
  gain_preview?: string;
  path?: string;
  source?: "path" | "package_shim";
  exec_command?: string;
  exec_args_prefix?: string[];
  exec_shell?: boolean;
};

export type RootSource = "tool_arg" | "env" | "mcp_roots" | "cwd" | "fallback";
