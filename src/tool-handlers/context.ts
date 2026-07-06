import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

import type { ExtractedSymbol, RootSource } from "../types.js";

export type ToolStatements = Record<string, Database.Statement>;

export type ProjectContextAdvisory = {
  code: "cross_project_reference";
  severity: "info";
  advisory_only: true;
  previous_project_root: string;
  current_project_root: string;
  external_reference: true;
  read_only_reference: true;
  not_current_requirement_scope: true;
  message: string;
};

export type ToolHandlerContext = {
  ensureInitializedForArgs: (rawArgs: Record<string, unknown>) => Promise<void>;
  consumeProjectContextAdvisory: () => ProjectContextAdvisory | null;
  getDb: () => Database.Database;
  getProjectRoot: () => string;
  getRootSource: () => RootSource;
  getDbPath: () => string;
  isWatcherEnabled: () => boolean;
  isWatcherReady: () => boolean;
  isFtsAvailable: () => boolean;
  ftsTableName: string;
  getIndexFileSymbolsTx: () => ((filePath: string, symbols: ExtractedSymbol[]) => void) | null;
  getStatements: () => ToolStatements;
  normalizeToDbPath: (inputPath: string) => string;
  sha256Hex: (input: string) => string;
  escapeLike: (pattern: string) => string;
  getFileStateHash: (dbOrAbsPath: string) => string | null;
};

export type ToolHandler = (
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
) => CallToolResult | Promise<CallToolResult>;
