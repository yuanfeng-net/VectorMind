import fs from "node:fs";
import path from "node:path";

import type { MemoryItemRow, RequirementRow } from "./types.js";
import {
  DEVELOPMENT_BLOCK_FILE_LINES,
  DEVELOPMENT_HUGE_FILE_LINES,
  DEVELOPMENT_WARN_FILE_BYTES,
  DEVELOPMENT_WARN_FILE_LINES,
  DEVELOPMENT_WARN_PENDING_FILES,
} from "./config.js";
import { looksLikeGeneratedFile, shouldIgnoreDbFilePath } from "./path-rules.js";

type DevelopmentWarningsContext = {
  getProjectRoot: () => string;
  normalizeToDbPath: (inputPath: string) => string;
  listActiveRequirements: (limit: number) => RequirementRow[];
  getRequirementMemoryItemId: (reqId: number) => { id: number } | undefined;
  getMemoryItemById: (id: number) => MemoryItemRow | undefined;
  parseMetadataJson: (raw: string | null | undefined) => Record<string, unknown>;
};

let devWarningContext: DevelopmentWarningsContext | null = null;

export function configureDevelopmentWarnings(context: DevelopmentWarningsContext): void {
  devWarningContext = context;
}

function requireDevelopmentWarningsContext(): DevelopmentWarningsContext {
  if (!devWarningContext) throw new Error("[VectorMind] development warning context is not configured");
  return devWarningContext;
}

function getProjectRoot(): string {
  return requireDevelopmentWarningsContext().getProjectRoot();
}

function normalizeToDbPath(inputPath: string): string {
  return requireDevelopmentWarningsContext().normalizeToDbPath(inputPath);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
type DevelopmentWarning = {
  code:
    | "large_file"
    | "very_large_file"
    | "huge_file_modularization_required"
    | "generated_source_not_editable"
    | "many_pending_files"
    | "broad_change_surface"
    | "unspecified_change_target"
    | "large_file_read"
    | "cross_project_path"
    | "multiple_active_requirements"
    | "broad_requirement_scope"
    | "scope_drift"
    | "scope_contract_missing"
    | "requirement_mapping_missing";
  severity: "info" | "warning" | "blocker";
  message: string;
  files?: string[];
  details?: Record<string, unknown>;
};

export type ChangeMode =
  | "feature"
  | "bugfix"
  | "refactor"
  | "mechanical_modularization"
  | "emergency_hotfix";
type DevelopmentWarningFileInput = {
  file_path: string;
  last_event?: string;
  event?: string;
  updated_at?: string;
};
type PathScopeCheck = {
  input_path: string;
  abs_path: string;
  in_project: boolean;
  project_root: string;
};
type RequirementScopeContract = {
  allow_terms: string[];
  deny_terms: string[];
  allowed_paths: string[];
  denied_paths: string[];
  inferred_from: string[];
};
type RequirementItem = {
  id: string;
  text: string;
};
type PlannedRequirementChange = {
  file?: string;
  change: string;
  requirement_refs?: string[];
  supporting_change?: boolean;
  change_type?: string;
};

export function isLikelySourceImplementationFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".cs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".vue",
    ".svelte",
  ]).has(ext);
}

export function countFileLinesBounded(absPath: string, maxBytes: number): { lines: number; truncated: boolean } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const bytesToRead = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    let lines = read > 0 ? 1 : 0;
    for (let i = 0; i < read; i++) {
      if (buffer[i] === 10) lines += 1;
    }
    return { lines, truncated: stat.size > bytesToRead };
  } finally {
    fs.closeSync(fd);
  }
}

function countFileLinesToThreshold(
  absPath: string,
  stopAtLines: number,
  maxBytes = 32_000_000,
): { lines: number; truncated: boolean } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const fd = fs.openSync(absPath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let lines = stat.size > 0 ? 1 : 0;
  let offset = 0;
  try {
    while (offset < stat.size && offset < maxBytes && lines < stopAtLines) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) lines += 1;
      }
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { lines, truncated: offset < stat.size };
}

function generatedSourceWarning(filePath: string, absPath: string): DevelopmentWarning | null {
  if (shouldIgnoreDbFilePath(filePath)) {
    return {
      code: "generated_source_not_editable",
      severity: "blocker",
      message: "This path is generated, vendored, dependency, cache, or build output. Regenerate it or change the source-of-truth file instead of editing or modularizing it.",
      files: [filePath],
    };
  }
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buffer = Buffer.alloc(16_384);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (!looksLikeGeneratedFile(buffer.subarray(0, bytesRead).toString("utf8"))) return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return {
    code: "generated_source_not_editable",
    severity: "blocker",
    message: "This source file declares that it is generated. Change its generator or source-of-truth instead of editing or mechanically splitting the generated output.",
    files: [filePath],
  };
}
function isPathInsideProjectRoot(absPath: string): boolean {
  const root = path.resolve(getProjectRoot());
  const rel = path.relative(root, path.resolve(absPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function checkPathScope(inputPath: string): PathScopeCheck {
  const normalizedInput = inputPath.trim() || ".";
  const absPath = path.resolve(path.isAbsolute(normalizedInput) ? normalizedInput : path.join(getProjectRoot(), normalizedInput));
  return {
    input_path: inputPath,
    abs_path: absPath,
    in_project: isPathInsideProjectRoot(absPath),
    project_root: path.resolve(getProjectRoot()),
  };
}

export function buildCrossProjectPathWarnings(paths: string[] | null | undefined): DevelopmentWarning[] {
  const checks = (paths ?? []).map((p) => checkPathScope(p)).filter((c) => !c.in_project);
  if (!checks.length) return [];
  return [
    {
      code: "cross_project_path",
      severity: "warning",
      message:
        "A path points outside the current project_root. Switch project_root intentionally before reading/searching another repo; do not mix unrelated project context into the current requirement.",
      files: checks.slice(0, 10).map((c) => c.input_path),
      details: {
        project_root: path.resolve(getProjectRoot()),
        paths: checks.slice(0, 10),
        total_paths: checks.length,
      },
    },
  ];
}
function buildLargeImplementationFileWarning(args: {
  code: "large_file" | "very_large_file" | "large_file_read" | "huge_file_modularization_required";
  filePath: string;
  lineCount: number;
  bytes: number;
  lineCountTruncated?: boolean;
  reading?: boolean;
}): DevelopmentWarning {
  const linesValue = args.lineCountTruncated ? `${args.lineCount}+` : args.lineCount;
  if (args.lineCount >= DEVELOPMENT_HUGE_FILE_LINES) {
    return {
      code: "huge_file_modularization_required",
      severity: "warning",
      message:
        "This implementation file is huge. Before any normal feature work, perform mechanical modularization: move whole functions/types/impl blocks into real, clearly named modules/directories, avoid *.generated.* or *.parts files, preserve behavior, then run format/build/tests.",
      files: [args.filePath],
      details: {
        lines: linesValue,
        bytes: args.bytes,
        warn_lines: DEVELOPMENT_WARN_FILE_LINES,
        block_lines: DEVELOPMENT_BLOCK_FILE_LINES,
        huge_lines: DEVELOPMENT_HUGE_FILE_LINES,
        required_action: "mechanical_modularization",
        allowed_change_modes: ["mechanical_modularization", "emergency_hotfix"],
        forbidden_file_patterns: ["*.generated.*", "*.parts", "*.rs.parts", "*_part*", "[0-9]_*", "[0-9]-*", "[0-9].*"],
        mechanical_rules: [
          "move whole declarations only",
          "use real semantic module names and clear directory boundaries; do not use ordinal prefixes like 1_xxx or 2_xxx",
          "preserve behavior and public semantics",
          "only add necessary mod/use/pub(crate)/re-export glue",
          "run formatter, build, and tests after each phase",
        ],
        reading: !!args.reading,
      },
    };
  }
  return {
    code: args.code,
    severity: args.code === "large_file" || (args.code === "large_file_read" && args.lineCount < DEVELOPMENT_BLOCK_FILE_LINES)
      ? "warning"
      : "blocker",
    message:
      args.code === "large_file"
        ? "This implementation file is getting large. Prefer extracting focused modules instead of continuing to pile unrelated responsibilities into it."
        : args.reading
          ? "You are reading a very large implementation file. Do not keep patching new feature code into it; identify a narrow function and split new behavior into focused modules unless this task is explicitly a planned extraction."
          : "This implementation file is already very large. Do not add new feature code here by default; split into a focused module/service/component and keep this file as a thin entry.",
    files: [args.filePath],
    details: {
      lines: linesValue,
      bytes: args.bytes,
      warn_lines: DEVELOPMENT_WARN_FILE_LINES,
      block_lines: DEVELOPMENT_BLOCK_FILE_LINES,
      huge_lines: DEVELOPMENT_HUGE_FILE_LINES,
    },
  };
}

export function buildFileReadDevelopmentWarnings(filePath: string, absPath: string, stat?: fs.Stats): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  if (!isPathInsideProjectRoot(absPath)) {
    warnings.push(...buildCrossProjectPathWarnings([filePath]));
    return warnings;
  }
  if (!isLikelySourceImplementationFile(filePath)) return warnings;
  const generatedWarning = generatedSourceWarning(filePath, absPath);
  if (generatedWarning) return [generatedWarning];

  let st = stat;
  try {
    st ??= fs.statSync(absPath);
  } catch {
    return warnings;
  }
  if (!st.isFile()) return warnings;

  const lineInfo = countFileLinesToThreshold(absPath, DEVELOPMENT_HUGE_FILE_LINES);
  const lineCount = lineInfo?.lines ?? 0;
  const tooManyLines = lineCount >= DEVELOPMENT_BLOCK_FILE_LINES;
  const warnLines = lineCount >= DEVELOPMENT_WARN_FILE_LINES;
  const warnBytes = st.size >= DEVELOPMENT_WARN_FILE_BYTES;
  if (!tooManyLines && !warnLines && !warnBytes) return warnings;

  warnings.push(
    buildLargeImplementationFileWarning({
      code: "large_file_read",
      filePath,
      lineCount,
      lineCountTruncated: lineInfo?.truncated,
      bytes: st.size,
      reading: true,
    }),
  );
  return warnings;
}

export function buildMatchedFileDevelopmentWarnings(filePaths: Array<string | null | undefined>): DevelopmentWarning[] {
  const seen = new Set<string>();
  const warnings: DevelopmentWarning[] = [];
  for (const fp of filePaths) {
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    const abs = path.isAbsolute(fp) ? path.resolve(fp) : path.join(getProjectRoot(), fp);
    warnings.push(...buildFileReadDevelopmentWarnings(normalizeToDbPath(fp), abs));
    if (warnings.length >= 8) break;
  }
  return warnings;
}

export function buildRequirementStartWarnings(args: {
  title: string;
  background: string;
  close_previous: boolean;
}): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  const activeReqs = requireDevelopmentWarningsContext().listActiveRequirements(10);

  if (!args.close_previous && activeReqs.length > 0) {
    warnings.push({
      code: "multiple_active_requirements",
      severity: "warning",
      message:
        "Starting a requirement without closing previous active requirements can mix unrelated context. Only keep multiple active requirements when the user explicitly asked for parallel work.",
      details: {
        active_requirements: activeReqs.slice(0, 5).map((r) => ({ id: r.id, title: r.title, status: r.status })),
      },
    });
  }

  const text = `${args.title}\n${args.background}`.toLowerCase();
  const broadTerms = [
    "顺便",
    "一起",
    "所有",
    "全部",
    "整体",
    "重构",
    "统一",
    "优化一下",
    "顺手",
    "相关的",
    "all ",
    "everything",
    "refactor",
    "cleanup",
    "clean up",
  ];
  const matched = broadTerms.filter((term) => text.includes(term));
  if (matched.length >= 2 || text.length > 1800) {
    warnings.push({
      code: "broad_requirement_scope",
      severity: "warning",
      message:
        "The requirement wording looks broad. Treat the current user request as the only boundary; do not add extra workflows, fields, pages, interfaces, or touch completed related features unless explicitly required.",
      details: { matched_terms: matched.slice(0, 10), text_length: text.length },
    });
  }

  return warnings;
}
function normalizeScopeTerms(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((v) => v.trim()).filter(Boolean)));
}

export function normalizeRequirementItems(values: string[] | undefined): RequirementItem[] {
  return (values ?? [])
    .map((text, index) => ({ id: String(index + 1), text: text.trim() }))
    .filter((item) => item.text.length > 0);
}

export function getRequirementItems(reqId: number): RequirementItem[] {
  const memId = requireDevelopmentWarningsContext().getRequirementMemoryItemId(reqId)?.id;
  if (memId == null) return [];
  const row = requireDevelopmentWarningsContext().getMemoryItemById(memId);
  const meta = requireDevelopmentWarningsContext().parseMetadataJson(row?.metadata_json);
  const raw = meta.requirement_items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (typeof item === "string") return { id: String(index + 1), text: item.trim() };
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : String(index + 1);
      return text ? { id, text } : null;
    })
    .filter((item): item is RequirementItem => !!item);
}

function normalizeRequirementRef(value: string): string {
  return value.trim().replace(/^#+/, "").toLowerCase();
}

function plannedChangeIsSupporting(change: PlannedRequirementChange): boolean {
  if (change.supporting_change) return true;
  return new Set(["supporting_change", "mechanical_modularization", "validation", "formatting", "test", "build_fix"]).has(
    String(change.change_type ?? "").toLowerCase(),
  );
}

export function buildRequirementMappingWarnings(args: {
  requirement?: RequirementRow;
  requirement_items?: RequirementItem[];
  planned_changes?: PlannedRequirementChange[];
  files: Array<{ file_path: string }>;
  change_mode: ChangeMode;
}): DevelopmentWarning[] {
  const items = args.requirement_items ?? [];
  const planned = args.planned_changes ?? [];
  const warnings: DevelopmentWarning[] = [];
  if (!items.length && !planned.length) return warnings;

  if (args.change_mode === "mechanical_modularization" && planned.every(plannedChangeIsSupporting)) {
    return warnings;
  }

  if (items.length && args.files.length > 0 && planned.length === 0) {
    warnings.push({
      code: "requirement_mapping_missing",
      severity: "warning",
      message:
        "This requirement has explicit requirement_items, but the planned file changes were not mapped to those items. Add planned_changes with requirement_refs, or mark purely mechanical/test/build/formatting work as supporting_change.",
      files: args.files.map((f) => normalizeToDbPath(f.file_path)).slice(0, 12),
      details: {
        requirement_id: args.requirement?.id ?? null,
        requirement_title: args.requirement?.title ?? null,
        requirement_items: items.slice(0, 20),
        expected_planned_changes: true,
      },
    });
    return warnings;
  }

  if (!items.length && planned.length > 0) {
    warnings.push({
      code: "requirement_mapping_missing",
      severity: "info",
      message:
        "planned_changes were provided, but no requirement_items are available to verify them. This is advisory evidence only; if the user request has explicit bullets, pass requirement_items to start_requirement or preflight_change_scope.",
      files: planned.map((p) => p.file).filter((v): v is string => typeof v === "string").slice(0, 12),
      details: {
        requirement_id: args.requirement?.id ?? null,
        requirement_title: args.requirement?.title ?? null,
      },
    });
    return warnings;
  }

  const validRefs = new Set<string>();
  for (const item of items) {
    validRefs.add(normalizeRequirementRef(item.id));
    validRefs.add(normalizeRequirementRef(`#${item.id}`));
    validRefs.add(normalizeRequirementRef(item.text));
  }

  const missing = planned.filter((change) => {
    if (plannedChangeIsSupporting(change)) return false;
    const refs = change.requirement_refs ?? [];
    if (!refs.length) return true;
    return refs.every((ref) => !validRefs.has(normalizeRequirementRef(ref)));
  });
  const plannedFiles = new Set(
    planned
      .map((change) => change.file)
      .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
      .map((file) => normalizeToDbPath(file)),
  );
  const unmappedFiles = args.files
    .map((f) => normalizeToDbPath(f.file_path))
    .filter((filePath) => filePath !== "(unspecified)" && !plannedFiles.has(filePath));

  if (missing.length || unmappedFiles.length) {
    warnings.push({
      code: "requirement_mapping_missing",
      severity: "blocker",
      message:
        "One or more planned changes or target files do not map to any explicit user requirement item. Do not implement unrelated or self-expanded behavior; map every target file/change to a requirement item, mark purely mechanical/test/build/formatting support as supporting_change, or ask the user to expand the requirement.",
      files: Array.from(new Set([
        ...missing.map((m) => m.file).filter((v): v is string => typeof v === "string"),
        ...unmappedFiles,
      ])).slice(0, 12),
      details: {
        requirement_id: args.requirement?.id ?? null,
        requirement_title: args.requirement?.title ?? null,
        requirement_items: items.slice(0, 20),
        missing: missing.slice(0, 20),
        unmapped_files: unmappedFiles.slice(0, 20),
      },
    });
  }

  return warnings;
}

export function buildRequirementScopeContract(args: {
  title: string;
  background: string;
  scope_allow?: string[];
  scope_deny?: string[];
  allowed_paths?: string[];
  denied_paths?: string[];
}): RequirementScopeContract {
  const allowTerms = normalizeScopeTerms(args.scope_allow);
  const denyTerms = normalizeScopeTerms(args.scope_deny);
  const allowedPaths = normalizeScopeTerms(args.allowed_paths).map(normalizeToDbPath);
  const deniedPaths = normalizeScopeTerms(args.denied_paths).map((p) => p.replace(/\\/g, "/"));

  return {
    allow_terms: allowTerms,
    deny_terms: Array.from(new Set(denyTerms)),
    allowed_paths: Array.from(new Set(allowedPaths)),
    denied_paths: Array.from(new Set(deniedPaths)),
    inferred_from: [],
  };
}

export function getRequirementScopeContract(reqId: number): RequirementScopeContract | null {
  const memId = requireDevelopmentWarningsContext().getRequirementMemoryItemId(reqId)?.id;
  if (memId == null) return null;
  const row = requireDevelopmentWarningsContext().getMemoryItemById(memId);
  const meta = requireDevelopmentWarningsContext().parseMetadataJson(row?.metadata_json);
  const raw = meta.scope_contract;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    allow_terms: Array.isArray(obj.allow_terms) ? obj.allow_terms.filter((v): v is string => typeof v === "string") : [],
    deny_terms: Array.isArray(obj.deny_terms) ? obj.deny_terms.filter((v): v is string => typeof v === "string") : [],
    allowed_paths: Array.isArray(obj.allowed_paths) ? obj.allowed_paths.filter((v): v is string => typeof v === "string") : [],
    denied_paths: Array.isArray(obj.denied_paths) ? obj.denied_paths.filter((v): v is string => typeof v === "string") : [],
    inferred_from: Array.isArray(obj.inferred_from) ? obj.inferred_from.filter((v): v is string => typeof v === "string") : [],
  };
}
function wildcardToRegex(pattern: string): RegExp {
  const source = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(source, "i");
}
function pathMatchesAnyPattern(filePath: string, patterns: string[]): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.filter((p) => wildcardToRegex(p.replace(/\\/g, "/")).test(normalized));
}
function fileContentHasDeniedTerms(filePath: string, terms: string[]): string[] {
  if (!terms.length || filePath === "(unspecified)") return [];
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.join(getProjectRoot(), filePath);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > 2_000_000) return [];
  let content = "";
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const lower = `${filePath}\n${content.slice(0, 250_000)}`.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

export function mergeScopeContracts(
  base: RequirementScopeContract | null | undefined,
  extra: RequirementScopeContract | null | undefined,
): RequirementScopeContract | null {
  if (!base && !extra) return null;
  return {
    allow_terms: Array.from(new Set([...(base?.allow_terms ?? []), ...(extra?.allow_terms ?? [])])),
    deny_terms: Array.from(new Set([...(base?.deny_terms ?? []), ...(extra?.deny_terms ?? [])])),
    allowed_paths: Array.from(new Set([...(base?.allowed_paths ?? []), ...(extra?.allowed_paths ?? [])])),
    denied_paths: Array.from(new Set([...(base?.denied_paths ?? []), ...(extra?.denied_paths ?? [])])),
    inferred_from: Array.from(new Set([...(base?.inferred_from ?? []), ...(extra?.inferred_from ?? [])])),
  };
}

export function buildScopeDriftWarnings(args: {
  requirement?: RequirementRow;
  contract?: RequirementScopeContract | null;
  intent?: string;
  files: Array<{ file_path: string }>;
  includeMissingContractHint?: boolean;
}): DevelopmentWarning[] {
  const requirementContract = args.requirement ? getRequirementScopeContract(args.requirement.id) : null;
  const contract = mergeScopeContracts(requirementContract, args.contract);
  const hasScopeRules = !!contract && (
    contract.allow_terms.length > 0 ||
    contract.deny_terms.length > 0 ||
    contract.allowed_paths.length > 0 ||
    contract.denied_paths.length > 0
  );

  const warnings: DevelopmentWarning[] = [];
  if (!contract || !hasScopeRules) {
    if (args.includeMissingContractHint && args.files.length > 0) {
      warnings.push({
        code: "scope_contract_missing",
        severity: "warning",
        message:
          "No explicit scope allow/deny contract is set for this requirement, so the planned files cannot be proven in-scope before editing. Define scope_allow/scope_deny or allowed_paths/denied_paths before editing.",
        files: args.files.map((f) => normalizeToDbPath(f.file_path)).slice(0, 12),
        details: {
          requirement_id: args.requirement?.id ?? null,
          requirement_title: args.requirement?.title ?? null,
        },
      });
    }
    return warnings;
  }

  const allowTerms = contract.allow_terms;
  const denyTerms = contract.deny_terms;
  const allowedPaths = contract.allowed_paths;
  const deniedPaths = contract.denied_paths;
  const intentText = args.intent ?? "";
  const intentDenied = denyTerms.filter((term) => intentText.toLowerCase().includes(term.toLowerCase()));

  const suspicious: Array<{ file_path: string; matched_terms: string[]; matched_paths: string[] }> = [];
  for (const f of args.files) {
    const fp = normalizeToDbPath(f.file_path);
    if (fp === "(unspecified)") continue;
    const matchedDeniedPaths = pathMatchesAnyPattern(fp, deniedPaths);
    const matchedDeniedTerms = [
      ...denyTerms.filter((term) => fp.toLowerCase().includes(term.toLowerCase())),
      ...fileContentHasDeniedTerms(fp, denyTerms),
    ];
    const isExplicitlyAllowed =
      pathMatchesAnyPattern(fp, allowedPaths).length > 0 ||
      allowTerms.some((term) => fp.toLowerCase().includes(term.toLowerCase()));
    const violatesAllowedPaths = allowedPaths.length > 0 && pathMatchesAnyPattern(fp, allowedPaths).length === 0;
    if (
      (matchedDeniedPaths.length || matchedDeniedTerms.length || intentDenied.length || violatesAllowedPaths) &&
      !isExplicitlyAllowed
    ) {
      suspicious.push({
        file_path: fp,
        matched_terms: Array.from(new Set([...matchedDeniedTerms, ...intentDenied])).slice(0, 12),
        matched_paths: [
          ...matchedDeniedPaths.slice(0, 12),
          ...(violatesAllowedPaths ? [`outside allowed_paths: ${allowedPaths.slice(0, 5).join(", ")}`] : []),
        ],
      });
    }
  }

  if (suspicious.length) {
    warnings.push({
      code: "scope_drift",
      severity: "blocker",
      message:
        "The current requirement appears to be touching a denied or out-of-scope domain. Stop and narrow the change unless the user explicitly expanded this requirement.",
      files: suspicious.slice(0, 12).map((s) => s.file_path),
      details: {
        requirement_id: args.requirement?.id ?? null,
        requirement_title: args.requirement?.title ?? null,
        inferred_from: contract.inferred_from,
        deny_terms: denyTerms.slice(0, 30),
        denied_paths: deniedPaths.slice(0, 30),
        suspicious: suspicious.slice(0, 12),
      },
    });
  }

  return warnings;
}

export function buildDevelopmentWarnings(
  files: DevelopmentWarningFileInput[],
  opts: { includeUnspecified?: boolean } = {},
): DevelopmentWarning[] {
  const warnings: DevelopmentWarning[] = [];
  const uniqueFiles = Array.from(
    new Set(
      files
        .map((f) => f.file_path)
        .filter((f) => !!f && f !== "(unspecified)")
        .map((f) => normalizeToDbPath(f)),
    ),
  );

  if (opts.includeUnspecified || files.some((f) => f.file_path === "(unspecified)")) {
    warnings.push({
      code: "unspecified_change_target",
      severity: "warning",
      message:
        "No changed file target was captured. For development work, sync concrete files so the current requirement owns only its real changes.",
    });
  }

  if (uniqueFiles.length >= DEVELOPMENT_WARN_PENDING_FILES) {
    warnings.push({
      code: "many_pending_files",
      severity: "warning",
      message:
        "This requirement touches many files. Re-check the user request and keep only files required by the current requirement.",
      files: uniqueFiles.slice(0, 20),
      details: { total_files: uniqueFiles.length, threshold: DEVELOPMENT_WARN_PENDING_FILES },
    });
  }

  const topDirs = new Set(
    uniqueFiles
      .map((f) => f.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "")
      .filter(Boolean),
  );
  if (uniqueFiles.length >= 6 && topDirs.size >= 4) {
    warnings.push({
      code: "broad_change_surface",
      severity: "warning",
      message:
        "Changed files span several top-level areas. Avoid modifying completed or merely related features unless the current requirement explicitly needs it.",
      files: uniqueFiles.slice(0, 20),
      details: { top_level_dirs: Array.from(topDirs).slice(0, 12), total_dirs: topDirs.size },
    });
  }

  for (const relPath of uniqueFiles) {
    if (!isLikelySourceImplementationFile(relPath)) continue;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(getProjectRoot(), relPath);
    const generatedWarning = generatedSourceWarning(relPath, absPath);
    if (generatedWarning) {
      warnings.push(generatedWarning);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const lineInfo = countFileLinesToThreshold(absPath, DEVELOPMENT_HUGE_FILE_LINES);
    const lineCount = lineInfo?.lines ?? 0;
    const tooManyLines = lineCount >= DEVELOPMENT_BLOCK_FILE_LINES;
    const warnLines = lineCount >= DEVELOPMENT_WARN_FILE_LINES;
    const warnBytes = stat.size >= DEVELOPMENT_WARN_FILE_BYTES;
    if (!tooManyLines && !warnLines && !warnBytes) continue;

    warnings.push(
      buildLargeImplementationFileWarning({
        code: tooManyLines ? "very_large_file" : "large_file",
        filePath: relPath,
        lineCount,
        lineCountTruncated: lineInfo?.truncated,
        bytes: stat.size,
      }),
    );
  }

  return warnings;
}
function isLargeFileWarningCode(code: DevelopmentWarning["code"]): boolean {
  return (
    code === "large_file" ||
    code === "very_large_file" ||
    code === "large_file_read" ||
    code === "huge_file_modularization_required"
  );
}

export function isDevelopmentWarningBlockingForChangeMode(warning: DevelopmentWarning, changeMode: ChangeMode): boolean {
  if (warning.code === "huge_file_modularization_required") {
    return changeMode !== "mechanical_modularization" && changeMode !== "emergency_hotfix";
  }
  if (isLargeFileWarningCode(warning.code)) return false;
  if (warning.code === "generated_source_not_editable") return true;
  return warning.severity === "blocker" &&
    (warning.code === "scope_drift" || warning.code === "cross_project_path");
}

