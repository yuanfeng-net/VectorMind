import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import crypto from "node:crypto";

import { normalizeToDbPath } from "./root.js";

type TopLevelDeclaration = {
  line: number;
  end_line: number;
  kind: string;
  name: string;
  signature: string;
  suggested_module: string;
};

export const LARGE_FILE_SPLIT_PLANNER_VERSION = 2;

export type LargeFileSplitModuleOverride = {
  module: string;
  target_path: string;
  declaration_names?: string[];
  line_ranges?: Array<{ start: number; end: number }>;
};

export type LargeFileSplitModule = {
  module: string;
  target_path: string;
  declaration_count: number;
  estimated_lines: number;
  declarations: string[];
  omitted_declarations: number;
  dependencies: string[];
  reason: string;
};

export type LargeFileSplitPlan = {
  ok: boolean;
  file_path: string;
  line_count: number;
  bytes: number;
  source_content_hash: string;
  planner_fingerprint: string;
  huge_threshold_lines: number;
  required_action: "mechanical_modularization";
  intent: string;
  target_dir: string;
  analysis_mode: "heuristic_stream";
  confidence: "low";
  coverage: {
    detected_declarations: number;
    assigned_declarations: number;
    omitted_declarations: number;
    declaration_limit: number;
    complete: boolean;
  };
  module_constraints: {
    max_declarations_per_module: number;
    max_estimated_lines_per_module: number;
    oversized_modules: Array<{ module: string; declaration_count: number; estimated_lines: number }>;
    satisfied: boolean;
  };
  forbidden_patterns: string[];
  mechanical_rules: string[];
  modules: LargeFileSplitModule[];
  steps: string[];
  validation: string[];
  warnings: string[];
  notes: string[];
};

function oneLine(input: string | null | undefined, max = 120): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}...`;
}

export function hasOrdinalModuleName(input: string): boolean {
  const normalized = input.replace(/\\/g, "/").trim();
  return normalized.split("/").some((segment) => {
    const base = path.basename(segment, path.extname(segment));
    return /^\d+(?:$|[\s._-]+)/.test(base);
  });
}

function declarationRegexForExtension(ext: string): RegExp {
  switch (ext) {
    case ".rs":
      return /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static)\s+([A-Za-z_][\w]*)?/;
    case ".go":
      return /^\s*(?:func|type|const|var)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)?/;
    case ".py":
      return /^(?:class|async\s+def|def)\s+([A-Za-z_][\w]*)/;
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)?/;
    default:
      return /^\s*(?:(?:pub\s+)?(?:class|struct|enum|interface|type)\s+([A-Za-z_][\w]*)|(?:[A-Za-z_][\w:<>,\s*&?\[\]]+)\s+([A-Za-z_][\w]*)\s*\()/;
  }
}

const GENERIC_ROLE_TOKENS = new Set([
  "api", "app", "base", "client", "controller", "core", "data", "default", "factory", "handler",
  "helper", "impl", "manager", "model", "module", "provider", "repository", "request", "response",
  "service", "state", "store", "type", "types", "util", "utils", "view",
]);

function identifierTokens(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function moduleNameFromDeclaration(name: string, signature: string): string {
  const text = `${name} ${signature}`.toLowerCase();
  const infrastructureRules: Array<[RegExp, string]> = [
    [/(config|setting|environment|\benv\b)/, "config"],
    [/(database|storage|persist|cache|transaction)/, "storage"],
    [/(http|api|client|request|response|transport)/, "transport"],
    [/(log|logger|redact|telemetry|metric)/, "observability"],
    [/(window|dialog|form|component|render|button|view)/, "ui"],
    [/(repair|cleanup|migration|probe|health)/, "maintenance"],
    [/(path|sanitize|normalize|parse|format|convert)/, "utilities"],
    [/(test|mock|fixture)/, "tests"],
  ];
  for (const [pattern, moduleName] of infrastructureRules) {
    if (pattern.test(text)) return moduleName;
  }

  const domainToken = identifierTokens(name).find(
    (token) => token.length >= 3 && !GENERIC_ROLE_TOKENS.has(token) && !/^\d+$/.test(token),
  );
  return domainToken?.replace(/[^a-z0-9_-]/g, "") || "core";
}

function braceDelta(line: string): number {
  const withoutStrings = line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/\/\/.*$/, "");
  let delta = 0;
  for (const char of withoutStrings) {
    if (char === "{") delta += 1;
    if (char === "}") delta -= 1;
  }
  return delta;
}

async function scanTopLevelDeclarations(
  absPath: string,
  ext: string,
  declarationLimit: number,
): Promise<{ lineCount: number; detected: number; declarations: TopLevelDeclaration[]; contentHash: string }> {
  const declarations: TopLevelDeclaration[] = [];
  const regex = declarationRegexForExtension(ext);
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(absPath);
  stream.on("data", (chunk) => hash.update(chunk));
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const braceLanguage = ext !== ".py";
  let lineCount = 0;
  let detected = 0;
  let depth = 0;

  try {
    for await (const raw of reader) {
      lineCount += 1;
      const trimmed = raw.trim();
      const topLevel = !braceLanguage ? raw.length === raw.trimStart().length : depth === 0;
      if (topLevel && trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
        const match = raw.match(regex);
        if (match) {
          detected += 1;
          if (declarations.length < declarationLimit) {
            const fallback = trimmed.split(/\s+/).slice(0, 3).join("_").replace(/[^\w$]+/g, "_");
            const matchedName = match.slice(1).find((value) => typeof value === "string" && value.length > 0);
            const name = (matchedName || fallback || `declaration_${lineCount}`).replace(/^[^A-Za-z_]+/, "") || `declaration_${lineCount}`;
            const kind = trimmed.split(/\s+/).find((part) =>
              ["fn", "function", "class", "struct", "enum", "trait", "impl", "mod", "type", "const", "static", "interface"].includes(
                part.replace(/[({].*$/, ""),
              ),
            ) ?? "declaration";
            const previous = declarations.at(-1);
            if (previous) previous.end_line = Math.max(previous.line, lineCount - 1);
            declarations.push({
              line: lineCount,
              end_line: lineCount,
              kind,
              name,
              signature: oneLine(trimmed, 220),
              suggested_module: moduleNameFromDeclaration(name, trimmed),
            });
          }
        }
      }
      if (braceLanguage) depth = Math.max(0, depth + braceDelta(raw));
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const finalDeclaration = declarations.at(-1);
  if (finalDeclaration) finalDeclaration.end_line = Math.max(finalDeclaration.line, lineCount);
  return { lineCount, detected, declarations, contentHash: hash.digest("hex") };
}

export async function countFileLinesStreaming(absPath: string): Promise<number> {
  const stream = fs.createReadStream(absPath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const _line of reader) lineCount += 1;
  } finally {
    reader.close();
    stream.destroy();
  }
  return lineCount;
}

export async function hashFileContentStreaming(absPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(absPath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function targetPathForModule(originalFilePath: string, targetDir: string, moduleName: string): string {
  const ext = path.extname(originalFilePath) || ".txt";
  const normalizedTargetDir = targetDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedTargetDir || normalizedTargetDir === ".") return `${moduleName}${ext}`;
  return `${normalizedTargetDir}/${moduleName}${ext}`;
}

function boundedModuleGroups(
  declarations: TopLevelDeclaration[],
  maxModules: number,
): Map<string, TopLevelDeclaration[]> {
  const initial = new Map<string, TopLevelDeclaration[]>();
  for (const declaration of declarations) {
    const list = initial.get(declaration.suggested_module) ?? [];
    list.push(declaration);
    initial.set(declaration.suggested_module, list);
  }
  if (initial.size <= maxModules) return initial;

  const core = [...(initial.get("core") ?? [])];
  const ranked = [...initial.entries()]
    .filter(([name]) => name !== "core")
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const kept = new Map(ranked.slice(0, Math.max(1, maxModules - 1)));
  for (const [, overflow] of ranked.slice(Math.max(1, maxModules - 1))) core.push(...overflow);
  if (core.length) kept.set("core", core.sort((a, b) => a.line - b.line));
  return kept;
}

function overriddenModuleGroups(
  declarations: TopLevelDeclaration[],
  overrides: LargeFileSplitModuleOverride[],
): {
  groups: Map<string, TopLevelDeclaration[]>;
  targetPaths: Map<string, string>;
  assignedCount: number;
  complete: boolean;
  warnings: string[];
} {
  const groups = new Map<string, TopLevelDeclaration[]>();
  const targetPaths = new Map<string, string>();
  const assigned = new Map<TopLevelDeclaration, string>();
  const warnings: string[] = [];

  for (const override of overrides) {
    const names = new Set(override.declaration_names ?? []);
    const ranges = override.line_ranges ?? [];
    const matches = declarations.filter((declaration) =>
      names.has(declaration.name) || ranges.some((range) => declaration.line >= range.start && declaration.line <= range.end)
    );
    if (!names.size && !ranges.length) {
      warnings.push(`Module override ${override.module} has no declaration_names or line_ranges selector.`);
    }
    if (!matches.length) warnings.push(`Module override ${override.module} did not match any detected declaration.`);
    const accepted: TopLevelDeclaration[] = [];
    for (const declaration of matches) {
      const previousModule = assigned.get(declaration);
      if (previousModule) {
        warnings.push(
          `Declaration ${declaration.name} @L${declaration.line} is assigned to both ${previousModule} and ${override.module}.`,
        );
        continue;
      }
      assigned.set(declaration, override.module);
      accepted.push(declaration);
    }
    groups.set(override.module, accepted.sort((a, b) => a.line - b.line));
    targetPaths.set(override.module, override.target_path);
  }

  const unassigned = declarations.filter((declaration) => !assigned.has(declaration));
  if (unassigned.length) {
    warnings.push(
      `${unassigned.length} detected declarations are not assigned by module_overrides: ${unassigned
        .slice(0, 12)
        .map((declaration) => `${declaration.name}@L${declaration.line}`)
        .join(", ")}.`,
    );
  }
  return {
    groups,
    targetPaths,
    assignedCount: assigned.size,
    complete: declarations.length > 0 && assigned.size === declarations.length && warnings.length === 0,
    warnings,
  };
}

function moduleDependencies(groups: Map<string, TopLevelDeclaration[]>): Map<string, string[]> {
  const declarationModules = new Map<string, string>();
  for (const [moduleName, declarations] of groups) {
    for (const declaration of declarations) declarationModules.set(declaration.name.toLowerCase(), moduleName);
  }
  const result = new Map<string, string[]>();
  for (const [moduleName, declarations] of groups) {
    const dependencies = new Set<string>();
    for (const declaration of declarations) {
      const referencedNames = declaration.signature.toLowerCase().match(/[a-z_$][\w$]*/g) ?? [];
      for (const name of referencedNames) {
        const dependencyModule = declarationModules.get(name);
        if (dependencyModule && dependencyModule !== moduleName) dependencies.add(dependencyModule);
      }
    }
    result.set(moduleName, [...dependencies].sort());
  }
  return result;
}

export async function buildLargeFileSplitPlan(args: {
  filePath: string;
  absPath: string;
  intent: string;
  targetDir?: string;
  maxModules: number;
  hugeThresholdLines: number;
  declarationLimit?: number;
  maxDeclarationsPerModule?: number;
  maxEstimatedLinesPerModule?: number;
  moduleOverrides?: LargeFileSplitModuleOverride[];
  plannerFingerprint: string;
}): Promise<LargeFileSplitPlan> {
  const stat = fs.statSync(args.absPath);
  const ext = path.extname(args.absPath).toLowerCase();
  const declarationLimit = Math.max(500, args.declarationLimit ?? 10_000);
  const maxDeclarationsPerModule = Math.min(200, Math.max(20, args.maxDeclarationsPerModule ?? 200));
  const maxEstimatedLinesPerModule = Math.min(1200, Math.max(100, args.maxEstimatedLinesPerModule ?? 1200));
  const scan = await scanTopLevelDeclarations(args.absPath, ext, declarationLimit);
  const baseName = path.basename(args.filePath, path.extname(args.filePath));
  const parentDir = path.dirname(args.filePath).replace(/\\/g, "/");
  const defaultTargetDir = parentDir === "." ? baseName : `${parentDir}/${baseName}`;
  const targetDir = normalizeToDbPath(args.targetDir ?? defaultTargetDir);
  const overrideResult = args.moduleOverrides?.length
    ? overriddenModuleGroups(scan.declarations, args.moduleOverrides)
    : null;
  const groups = overrideResult?.groups ?? boundedModuleGroups(scan.declarations, args.maxModules);
  const dependencies = moduleDependencies(groups);
  const modules = [...groups.entries()]
    .sort((a, b) => a[1][0]?.line - b[1][0]?.line)
    .map(([moduleName, declarations]) => ({
      module: moduleName,
      target_path: overrideResult?.targetPaths.get(moduleName) ?? targetPathForModule(args.filePath, targetDir, moduleName),
      declaration_count: declarations.length,
      estimated_lines: declarations.reduce(
        (total, declaration) => total + Math.max(1, declaration.end_line - declaration.line + 1),
        0,
      ),
      declarations: declarations.slice(0, 48).map((declaration) => `${declaration.kind} ${declaration.name} @L${declaration.line}`),
      omitted_declarations: Math.max(0, declarations.length - 48),
      dependencies: dependencies.get(moduleName) ?? [],
      reason: moduleName === "core"
        ? "Fallback group for declarations without a stable domain boundary; refine this group before moving it as one module."
        : `Group declarations around the ${moduleName} domain/infrastructure boundary while preserving behavior.`,
    }));
  const omitted = Math.max(0, scan.detected - scan.declarations.length);
  const complete = omitted === 0 && scan.declarations.length > 0 && (overrideResult?.complete ?? true);
  const coreCount = groups.get("core")?.length ?? 0;
  const coreNeedsRefinement = !overrideResult && coreCount > Math.max(12, Math.floor(scan.declarations.length * 0.35));
  const oversizedModules = modules
    .filter(
      (module) =>
        module.declaration_count > maxDeclarationsPerModule ||
        module.estimated_lines >= maxEstimatedLinesPerModule,
    )
    .map((module) => ({
      module: module.module,
      declaration_count: module.declaration_count,
      estimated_lines: module.estimated_lines,
    }));
  const warnings: string[] = [];
  warnings.push(...(overrideResult?.warnings ?? []));
  if (groups.size > args.maxModules) {
    warnings.push(`module_overrides defines ${groups.size} modules, exceeding max_modules=${args.maxModules}.`);
  }
  if (omitted > 0) warnings.push(`${omitted} declarations exceeded the safety limit; refine the plan before editing.`);
  if (!scan.detected) warnings.push("No top-level declarations were detected; a manual boundary plan is required before editing.");
  if (coreNeedsRefinement) {
    warnings.push(`The core fallback contains ${coreCount} declarations and must be refined into semantic modules before execution.`);
  }
  if (oversizedModules.length) {
    warnings.push(
      `Target modules exceed the ${maxDeclarationsPerModule}-declaration or ${maxEstimatedLinesPerModule}-line estimate: ${oversizedModules
        .slice(0, 8)
        .map((module) => `${module.module}=${module.declaration_count} declarations/${module.estimated_lines} lines`)
        .join(", ")}. Refine responsibilities instead of moving the god file intact.`,
    );
  }

  return {
    ok: complete && !coreNeedsRefinement && oversizedModules.length === 0 && groups.size <= args.maxModules,
    file_path: args.filePath,
    line_count: scan.lineCount,
    bytes: stat.size,
    source_content_hash: scan.contentHash,
    planner_fingerprint: args.plannerFingerprint,
    huge_threshold_lines: args.hugeThresholdLines,
    required_action: "mechanical_modularization",
    intent: args.intent,
    target_dir: targetDir,
    analysis_mode: "heuristic_stream",
    confidence: "low",
    coverage: {
      detected_declarations: scan.detected,
      assigned_declarations: overrideResult?.assignedCount ?? scan.declarations.length,
      omitted_declarations: omitted,
      declaration_limit: declarationLimit,
      complete,
    },
    module_constraints: {
      max_declarations_per_module: maxDeclarationsPerModule,
      max_estimated_lines_per_module: maxEstimatedLinesPerModule,
      oversized_modules: oversizedModules,
      satisfied: oversizedModules.length === 0,
    },
    forbidden_patterns: ["*.generated.*", "*.parts", "*.rs.parts", "*_part*", "*Part*", "[0-9]_*", "[0-9]-*", "[0-9].*"],
    mechanical_rules: [
      "Move only complete declarations/impl blocks/functions/classes/types; do not split a declaration body.",
      "Use real semantic module names and clear directory boundaries; do not create generated/parts/partN files or ordinal names.",
      "Preserve behavior, names, API semantics, data formats, side effects, and test expectations.",
      "Only add necessary module declarations, imports, visibility adjustments, and re-exports.",
      "Run formatter, build/check, and relevant tests after each small phase.",
    ],
    modules,
    steps: [
      "Keep this mechanical modularization attached to the current requirement and selected split plan.",
      "Move one cohesive declaration group at a time into the planned semantic module directory.",
      "Keep the original file as thin entry/orchestration glue where possible.",
      "After each group, run formatter and the smallest available compile/test command.",
      "Record in_progress or partial progress against the same plan_id.",
      "Mark the plan resolved only after module paths, remaining line count, and verification evidence pass validation.",
    ],
    validation: [
      "Every detected declaration is assigned; coverage.complete must be true.",
      "No generated/parts/numbered module files or ordinal-prefixed directories were created.",
      "The original file is below the huge threshold or contains only thin orchestration glue.",
      "All recorded module paths exist under project_root.",
      "Formatter, build/check, and relevant tests pass.",
    ],
    warnings,
    notes: [
      `Detected ${scan.detected} top-level declarations with bounded-memory streaming analysis.`,
      "Dependency hints are signature-based; verify runtime/private-state dependencies against repository facts before moving code.",
    ],
  };
}
