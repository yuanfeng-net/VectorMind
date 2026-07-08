export { configureMemoryMaintenance } from "./memory-maintenance/context.js";
export { pruneFilenameNoiseIndexes, pruneIgnoredIndexesByPathPatterns } from "./memory-maintenance/index-prune.js";
export { runAutoMaintenanceIfDue, runMemoryMaintenance } from "./memory-maintenance/runner.js";
export type { MemoryMaintenanceContext } from "./memory-maintenance/context.js";
export type { MaintenanceResult } from "./memory-maintenance/types.js";
