import Database from "better-sqlite3";

export type MemoryMaintenanceContext = {
  getDb: () => Database.Database | undefined;
  getProjectRoot: () => string;
  getDbPath: () => string;
  getKvStatement: () => Database.Statement | undefined;
  getSetKvStatement: () => Database.Statement | undefined;
  getDeleteFileChunkItemsStatement: () => Database.Statement;
  getDeleteSymbolsForFileStatement: () => Database.Statement;
  getInsertMemoryItemStatement: () => Database.Statement;
  sha256Hex: (input: string) => string;
  parseMetadataJson: (raw: string | null | undefined) => Record<string, unknown>;
  metadataStatus: (row: { metadata_json: string | null | undefined }) => string | null;
  isHiddenFromDefaultRecall: (row: { metadata_json: string | null | undefined }) => boolean;
};

let memoryMaintenanceContext: MemoryMaintenanceContext | null = null;

export function configureMemoryMaintenance(context: MemoryMaintenanceContext): void {
  memoryMaintenanceContext = context;
}

function requireMemoryMaintenanceContext(): MemoryMaintenanceContext {
  if (!memoryMaintenanceContext) throw new Error("[VectorMind] memory maintenance context is not configured");
  return memoryMaintenanceContext;
}

export function hasDb(): boolean {
  return !!requireMemoryMaintenanceContext().getDb();
}

export function getDb(): Database.Database {
  const db = requireMemoryMaintenanceContext().getDb();
  if (!db) throw new Error("[VectorMind] database is not initialized");
  return db;
}

export function getProjectRoot(): string {
  return requireMemoryMaintenanceContext().getProjectRoot();
}

export function getDbPath(): string {
  return requireMemoryMaintenanceContext().getDbPath();
}

export function getKvStatement(): Database.Statement | undefined {
  return requireMemoryMaintenanceContext().getKvStatement();
}

export function getSetKvStatement(): Database.Statement | undefined {
  return requireMemoryMaintenanceContext().getSetKvStatement();
}

export function getDeleteFileChunkItemsStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getDeleteFileChunkItemsStatement();
}

export function getDeleteSymbolsForFileStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getDeleteSymbolsForFileStatement();
}

export function getInsertMemoryItemStatement(): Database.Statement {
  return requireMemoryMaintenanceContext().getInsertMemoryItemStatement();
}

export function sha256Hex(input: string): string {
  return requireMemoryMaintenanceContext().sha256Hex(input);
}

export function parseMetadataJson(raw: string | null | undefined): Record<string, unknown> {
  return requireMemoryMaintenanceContext().parseMetadataJson(raw);
}

export function metadataStatus(row: { metadata_json: string | null | undefined }): string | null {
  return requireMemoryMaintenanceContext().metadataStatus(row);
}

export function isHiddenFromDefaultRecall(row: { metadata_json: string | null | undefined }): boolean {
  return requireMemoryMaintenanceContext().isHiddenFromDefaultRecall(row);
}
