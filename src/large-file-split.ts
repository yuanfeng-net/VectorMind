import fs from "node:fs";
import path from "node:path";

import { normalizeToDbPath } from "./root.js";

type TopLevelDeclaration = {
  line: number;
  kind: string;
  name: string;
  signature: string;
  suggested_module: string;
};

export type LargeFileSplitPlan = {
  ok: true;
  file_path: string;
  line_count: number;
  bytes: number;
  huge_threshold_lines: number;
  required_action: "mechanical_modularization";
  intent: string;
  target_dir: string;
  forbidden_patterns: string[];
  mechanical_rules: string[];
  modules: Array<{ module: string; target_path: string; declarations: string[]; reason: string }>;
  steps: string[];
  validation: string[];
  notes: string[];
};

function oneLine(input: string | null | undefined, max = 120): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
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
      return /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|function|class|struct|enum|interface|type|const|static)\s+([A-Za-z_][\w]*)?/;
  }
}

function moduleNameFromDeclaration(name: string, signature: string): string {
  const text = `${name} ${signature}`.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/(config|setting|env)/, "config"],
    [/(state|store|persist)/, "state"],
    [/(api|client|request|response|heartbeat|activate|sync)/, "api"],
    [/(service|daemon|install|start|stop)/, "service"],
    [/(log|logger|redact)/, "logging"],
    [/(gui|window|dialog|form|view|button|list)/, "ui"],
    [/(share|disk|smb|unc|folder|directory)/, "share"],
    [/(repair|cleanup|probe|health)/, "maintenance"],
    [/(path|sanitize|normalize|host|ip|util|helper)/, "util"],
    [/(test|mock|fixture)/, "tests"],
  ];
  for (const [pattern, moduleName] of rules) {
    if (pattern.test(text)) return moduleName;
  }
  return "core";
}

function topLevelDeclarationsForPlan(content: string, ext: string, maxDecls = 160): TopLevelDeclaration[] {
  const decls: TopLevelDeclaration[] = [];
  const lines = content.split(/\r?\n/);
  const regex = declarationRegexForExtension(ext);
  for (let i = 0; i < lines.length && decls.length < maxDecls; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    const m = raw.match(regex);
    if (!m) continue;
    const fallback = trimmed.split(/\s+/).slice(0, 3).join("_").replace(/[^\w$]+/g, "_");
    const name = (m[1] || fallback || `declaration_${i + 1}`).replace(/^[^A-Za-z_]+/, "") || `declaration_${i + 1}`;
    const kind = trimmed.split(/\s+/).find((part) =>
      ["fn", "function", "class", "struct", "enum", "trait", "impl", "mod", "type", "const", "static", "interface"].includes(
        part.replace(/[({].*$/, ""),
      ),
    ) ?? "declaration";
    decls.push({
      line: i + 1,
      kind,
      name,
      signature: oneLine(trimmed, 180),
      suggested_module: moduleNameFromDeclaration(name, trimmed),
    });
  }
  return decls;
}

function targetPathForModule(originalFilePath: string, targetDir: string, moduleName: string): string {
  const ext = path.extname(originalFilePath) || ".txt";
  const normalizedTargetDir = targetDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedTargetDir || normalizedTargetDir === ".") return `${moduleName}${ext}`;
  return `${normalizedTargetDir}/${moduleName}${ext}`;
}

export function buildLargeFileSplitPlan(args: {
  filePath: string;
  absPath: string;
  intent: string;
  targetDir?: string;
  maxModules: number;
  hugeThresholdLines: number;
}): LargeFileSplitPlan {
  const content = fs.readFileSync(args.absPath, "utf8");
  const st = fs.statSync(args.absPath);
  const lines = content.split(/\r?\n/).length;
  const ext = path.extname(args.absPath).toLowerCase();
  const baseName = path.basename(args.filePath, path.extname(args.filePath));
  const parentDir = path.dirname(args.filePath).replace(/\\/g, "/");
  const defaultTargetDir = parentDir === "." ? baseName : `${parentDir}/${baseName}`;
  const targetDir = normalizeToDbPath(args.targetDir ?? defaultTargetDir);
  const declarations = topLevelDeclarationsForPlan(content, ext);
  const grouped = new Map<string, TopLevelDeclaration[]>();
  for (const decl of declarations) {
    const key = grouped.size >= args.maxModules && !grouped.has(decl.suggested_module) ? "core" : decl.suggested_module;
    const list = grouped.get(key) ?? [];
    list.push(decl);
    grouped.set(key, list);
  }
  if (!grouped.size) grouped.set("core", []);
  const modules = Array.from(grouped.entries())
    .slice(0, args.maxModules)
    .map(([moduleName, decls]) => ({
      module: moduleName,
      target_path: targetPathForModule(args.filePath, targetDir, moduleName),
      declarations: decls.slice(0, 24).map((d) => `${d.kind} ${d.name} @L${d.line}`),
      reason: `Move whole ${moduleName}-related declarations together without changing behavior.`,
    }));

  return {
    ok: true,
    file_path: args.filePath,
    line_count: lines,
    bytes: st.size,
    huge_threshold_lines: args.hugeThresholdLines,
    required_action: "mechanical_modularization",
    intent: args.intent,
    target_dir: targetDir,
    forbidden_patterns: ["*.generated.*", "*.parts", "*.rs.parts", "*_part*", "*Part*"],
    mechanical_rules: [
      "Move only complete declarations/impl blocks/functions/classes/types; do not split a declaration body.",
      "Use real module names and clear directory boundaries; do not create generated/parts/partN files.",
      "Preserve behavior, names, API semantics, data formats, side effects, and test expectations.",
      "Only add necessary module declarations, imports, pub(crate), and re-exports to make moved code compile.",
      "Run formatter, build/check, and relevant tests after each small phase.",
    ],
    modules,
    steps: [
      "Create a dedicated mechanical modularization requirement before touching the huge file.",
      "Add the target module directory and move one cohesive declaration group at a time.",
      "Keep the original file as a thin entry/mod orchestration file where possible.",
      "After each group, run formatter and the smallest available compile/test command.",
      "Record the split with record_large_file_split(status='partial' or 'resolved').",
      "Resume the original feature only after the target huge file is no longer the default place for new code.",
    ],
    validation: [
      "No *.generated.*, *.parts, *.rs.parts, or numbered part files were created.",
      "The original file line count decreased or contains only thin orchestration glue.",
      "Formatter passes.",
      "Build/check passes.",
      "Relevant tests pass.",
    ],
    notes: declarations.length
      ? [`Detected ${declarations.length} top-level declarations for mechanical grouping.`]
      : ["No top-level declarations were detected by lightweight scanning; split by obvious cohesive sections and verify after each move."],
  };
}
