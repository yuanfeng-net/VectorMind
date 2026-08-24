import type { MemoryItemRow, RequirementRow } from "./types.js";
import { isHiddenFromDefaultRecall, metadataStatus, toMemoryItemPreview } from "./memory-recall.js";
import { oneLine } from "./tool-output.js";
import { scanOperationPlanSecurity, type SecurityOverride } from "./security-signals.js";

export type CurrentConstraint = {
  id: number;
  kind: string;
  title: string | null;
  source: "current_decision" | "convention" | "active_requirement" | "recent_note";
  priority: number;
  preview: string;
  file_path: string | null;
  req_id: number | null;
  updated_at: string;
};

export type OperationPlanInput = {
  operation: string;
  intent?: string;
  commands?: string[];
  files?: string[];
  targets?: string[];
  script_hints?: string[];
};

export type OperationScopeWarning = {
  code: "operation_constraint_conflict" | "stale_default_conflict" | "operation_scope_unmapped" | "security_risk_detected";
  severity: "info" | "warning" | "blocker";
  message: string;
  evidence?: Array<{
    constraint_id: number;
    kind: string;
    title: string | null;
    source: CurrentConstraint["source"];
    preview: string;
  }>;
  details?: Record<string, unknown>;
};

export type OperationScopeResult = {
  ok: boolean;
  safe_to_proceed: boolean;
  read_only: true;
  advisory_only: true;
  enforcement_mode: "preflight_blocker";
  host_enforcement_required: true;
  security_override_applied: boolean;
  does_not_control_model_reasoning: true;
  does_not_control_host_runtime: true;
  does_not_replace_model_judgment: true;
  operation: string;
  intent: string;
  planned_commands: string[];
  planned_files: string[];
  planned_targets: string[];
  current_constraints: CurrentConstraint[];
  warnings: OperationScopeWarning[];
  recommended_action: string;
};

const NEGATION_PATTERNS = [
  /\bdo\s+not\b/i,
  /\bdon't\b/i,
  /\bmust\s+not\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\bforbid(?:den)?\b/i,
  /\bdeny\b/i,
  /\bdisallow\b/i,
  /\bno\s+longer\b/i,
  /\bnot\s+use\b/i,
  /\bwithout\b/i,
  /\bskip\b/i,
  /不得/,
  /不能/,
  /禁止/,
  /不要/,
  /不再/,
  /不用/,
  /不使用/,
  /无需/,
  /避免/,
  /不要再/,
];

const STALE_DEFAULT_HINT_PATTERNS = [
  /\blegacy\b/i,
  /\bold\b/i,
  /\bprevious\b/i,
  /\bfallback\b/i,
  /\bstale\b/i,
  /\bdeprecated\b/i,
  /\bobsolete\b/i,
  /旧/,
  /历史/,
  /回退/,
  /过时/,
  /废弃/,
  /老/,
];

const CURRENT_ALTERNATIVE_PATTERNS = [
  /\binstead\b/i,
  /\bcurrent\b/i,
  /\bnow\b/i,
  /\bonly\b/i,
  /\bsingle\b/i,
  /\bswitch(?:ed)?\s+to\b/i,
  /\bmigrat(?:e|ed|ing)\s+to\b/i,
  /\breplac(?:e|ed|ing)\s+(?:with|by|to)\b/i,
  /\bchanged?\s+to\b/i,
  /当前/,
  /现在/,
  /只保留/,
  /仅保留/,
  /改成/,
  /改为/,
  /改用/,
  /替换/,
  /迁移到/,
  /统一/,
  /最新/,
  /新的/,
];

const DEFAULT_HINT_PATTERNS = [
  /\bdefault\b/i,
  /\bfallback\b/i,
  /\bprefer(?:red)?\b/i,
  /\bauto(?:matic)?\b/i,
  /\blegacy\b/i,
  /\bold\b/i,
  /\bprevious\b/i,
  /默认/,
  /旧/,
  /历史/,
  /自动/,
  /优先/,
  /回退/,
];

const OPERATION_WORDS = [
  "deploy",
  "publish",
  "release",
  "start",
  "stop",
  "restart",
  "run",
  "build",
  "test",
  "migrate",
  "seed",
  "sync",
  "clean",
  "delete",
  "remove",
  "reset",
  "rollback",
  "commit",
  "push",
  "pull",
  "merge",
  "rebase",
  "部署",
  "发布",
  "上线",
  "启动",
  "停止",
  "重启",
  "构建",
  "测试",
  "迁移",
  "同步",
  "清理",
  "删除",
  "重置",
  "回滚",
  "提交",
  "推送",
];

const TOKEN_STOPWORDS = new Set([
  "operation",
  "operations",
  "command",
  "commands",
  "script",
  "scripts",
  "target",
  "targets",
  "current",
  "rule",
  "rules",
  "path",
  "instead",
  "using",
  "run",
  "use",
  "release",
  "deploy",
  "build",
  "test",
  "操作",
  "执行",
  "命令",
  "脚本",
  "目标",
  "当前",
  "规则",
  "路径",
  "使用",
  "运行",
  "发布",
  "部署",
  "构建",
  "测试",
]);

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").normalize("NFKC").toLowerCase();
}

function tokenize(input: string): string[] {
  const text = normalizeText(input);
  const tokens = new Set<string>();
  const addToken = (token: string): void => {
    if (token.length >= 2 && !TOKEN_STOPWORDS.has(token)) tokens.add(token);
  };
  for (const token of text.match(/[a-z0-9_./:@#-]{2,}/g) ?? []) {
    addToken(token);
    for (const part of token.split(/[^a-z0-9]+/)) {
      addToken(part);
    }
  }
  for (const seq of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (seq.length >= 2 && seq.length <= 18) addToken(seq);
    for (const n of [2, 3, 4]) {
      if (seq.length < n) continue;
      for (let i = 0; i <= seq.length - n; i++) addToken(seq.slice(i, i + n));
    }
  }
  return Array.from(tokens).filter((t) => t.length >= 2).slice(0, 80);
}

function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some((pattern) => pattern.test(text));
}

function hasDefaultHint(text: string): boolean {
  return DEFAULT_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

function hasStaleDefaultHint(text: string): boolean {
  return STALE_DEFAULT_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

function hasCurrentAlternativeHint(text: string): boolean {
  return CURRENT_ALTERNATIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function operationText(input: OperationPlanInput): string {
  return [
    input.operation,
    input.intent,
    ...(input.commands ?? []),
    ...(input.files ?? []),
    ...(input.targets ?? []),
    ...(input.script_hints ?? []),
  ].filter(Boolean).join("\n");
}

function concreteOperationText(input: OperationPlanInput): string {
  return [
    ...(input.commands ?? []),
    ...(input.files ?? []),
    ...(input.targets ?? []),
    ...(input.script_hints ?? []),
  ].filter(Boolean).join("\n");
}

function negatedConstraintText(text: string): string {
  const chunks = text
    .split(/[\n.;。；,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const negated = chunks.filter(hasNegation);
  return negated.length ? negated.join("\n") : text;
}

function tokenOverlapScore(a: string, b: string): number {
  const aTokens = tokenize(a);
  const bText = normalizeText(b);
  let score = 0;
  for (const token of aTokens) {
    if (bText.includes(token)) score += Math.min(4, Math.max(1, token.length / 3));
  }
  return score;
}

function operationKeywordOverlapScore(a: string, b: string): number {
  const aText = normalizeText(a);
  const bText = normalizeText(b);
  return OPERATION_WORDS.some((word) => {
    const normalizedWord = normalizeText(word);
    return aText.includes(normalizedWord) && bText.includes(normalizedWord);
  }) ? 2 : 0;
}

function explicitConflictScore(planText: string, deniedText: string): number {
  return tokenOverlapScore(planText, deniedText) + operationKeywordOverlapScore(planText, deniedText);
}

function rowPriority(row: MemoryItemRow, source: CurrentConstraint["source"]): number {
  if (source === "current_decision") return 100;
  if (source === "active_requirement") return 80;
  if (source === "convention") return 70;
  return 35;
}

function toConstraint(row: MemoryItemRow, source: CurrentConstraint["source"], previewChars: number): CurrentConstraint {
  const preview = toMemoryItemPreview(row, false, previewChars, 0);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    source,
    priority: rowPriority(row, source),
    preview: preview.preview,
    file_path: row.file_path,
    req_id: row.req_id,
    updated_at: row.updated_at,
  };
}

function requirementToMemoryRow(req: RequirementRow, memoryRow: MemoryItemRow | undefined): MemoryItemRow | null {
  if (memoryRow) return memoryRow;
  return {
    id: -req.id,
    kind: "requirement",
    title: req.title,
    content: `${req.title}\n\n${req.context_data}`,
    file_path: null,
    start_line: null,
    end_line: null,
    req_id: req.id,
    metadata_json: null,
    content_hash: "",
    created_at: req.created_at,
    updated_at: req.created_at,
  };
}

export function buildCurrentConstraints(args: {
  currentDecisions: MemoryItemRow[];
  conventions: MemoryItemRow[];
  activeRequirements: Array<{ requirement: RequirementRow; memory?: MemoryItemRow }>;
  recentNotes: MemoryItemRow[];
  limit?: number;
  previewChars?: number;
}): CurrentConstraint[] {
  const limit = args.limit ?? 12;
  const previewChars = args.previewChars ?? 180;
  const constraints = new Map<number, CurrentConstraint>();
  const add = (row: MemoryItemRow | null | undefined, source: CurrentConstraint["source"]): void => {
    if (!row) return;
    // The requirement table is authoritative for active work. A stale or hidden
    // linked memory row must not make an active requirement disappear here.
    if (source !== "active_requirement" && isHiddenFromDefaultRecall(row)) return;
    const existing = constraints.get(row.id);
    const next = toConstraint(row, source, previewChars);
    if (!existing || next.priority > existing.priority) constraints.set(row.id, next);
  };

  for (const row of args.currentDecisions) {
    if (metadataStatus(row) === "superseded") continue;
    add(row, "current_decision");
  }
  for (const row of args.conventions) add(row, "convention");
  for (const item of args.activeRequirements) add(requirementToMemoryRow(item.requirement, item.memory), "active_requirement");
  for (const row of args.recentNotes) add(row, "recent_note");

  const compareConstraints = (a: CurrentConstraint, b: CurrentConstraint): number =>
    b.priority - a.priority || Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id;
  const sorted = Array.from(constraints.values()).sort(compareConstraints);
  const active = sorted.filter((constraint) => constraint.source === "active_requirement");
  const nonActive = sorted.filter((constraint) => constraint.source !== "active_requirement");
  const boundedLimit = Math.max(1, Math.trunc(limit));
  const effectiveLimit = Math.max(boundedLimit, active.length);
  return [...active, ...nonActive.slice(0, Math.max(0, effectiveLimit - active.length))]
    .sort(compareConstraints);
}

function classifyConstraintConflict(plan: OperationPlanInput, constraint: CurrentConstraint): OperationScopeWarning | null {
  const constraintText = `${constraint.title ?? ""}\n${constraint.preview}`;
  if (!hasNegation(constraintText)) return null;
  const deniedText = negatedConstraintText(constraintText);
  const concreteText = concreteOperationText(plan);
  const naturalPlanText = `${plan.operation}\n${plan.intent ?? ""}`;
  const naturalScore = explicitConflictScore(naturalPlanText, deniedText);
  const concreteScore = explicitConflictScore(concreteText, deniedText);
  const alignedNaturalScore = hasNegation(naturalPlanText)
    ? explicitConflictScore(negatedConstraintText(naturalPlanText), deniedText)
    : 0;
  const naturalConflict = naturalScore >= 5 && alignedNaturalScore < 5;
  const concreteConflict = concreteText.trim().length > 0 && concreteScore >= 5;
  if (!naturalConflict && !concreteConflict) return null;
  const conflictSources = [
    ...(naturalConflict ? ["natural_plan"] : []),
    ...(concreteConflict ? ["concrete_details"] : []),
  ];
  const score = Math.max(naturalScore, concreteScore);
  return {
    code: "operation_constraint_conflict",
    severity: constraint.source === "current_decision" || constraint.source === "active_requirement" ? "blocker" : "warning",
    message:
      "The planned operation appears related to a current constraint that contains a deny/avoid/no-longer rule. Re-check the plan against the current user requirement before running commands.",
    evidence: [{
      constraint_id: constraint.id,
      kind: constraint.kind,
      title: constraint.title,
      source: constraint.source,
      preview: oneLine(constraint.preview, 220),
    }],
    details: {
      overlap_score: score,
      natural_plan_overlap_score: naturalScore,
      aligned_natural_plan_overlap_score: alignedNaturalScore,
      concrete_overlap_score: concreteScore,
      conflict_sources: conflictSources,
    },
  };
}

function classifyStaleDefaultConflict(plan: OperationPlanInput, constraint: CurrentConstraint): OperationScopeWarning | null {
  const scriptText = [...(plan.commands ?? []), ...(plan.targets ?? []), ...(plan.script_hints ?? [])].join("\n");
  if (!scriptText) return null;
  const constraintText = `${constraint.title ?? ""}\n${constraint.preview}`;
  const hasStaleRisk =
    hasStaleDefaultHint(scriptText) ||
    (hasDefaultHint(scriptText) && (hasNegation(constraintText) || hasCurrentAlternativeHint(constraintText)));
  if (!hasStaleRisk) return null;
  const score = tokenOverlapScore(scriptText, constraintText);
  if (score < 4) return null;
  return {
    code: "stale_default_conflict",
    severity: constraint.source === "current_decision" ? "blocker" : "warning",
    message:
      "A script/default/fallback mentioned in the operation overlaps with a newer current constraint. Treat repository defaults as possibly stale until aligned with the current decision or requirement.",
    evidence: [{
      constraint_id: constraint.id,
      kind: constraint.kind,
      title: constraint.title,
      source: constraint.source,
      preview: oneLine(constraint.preview, 220),
    }],
    details: { overlap_score: score },
  };
}

export function evaluateOperationScope(
  plan: OperationPlanInput,
  currentConstraints: CurrentConstraint[],
  securityOverride?: SecurityOverride,
): OperationScopeResult {
  const text = operationText(plan);
  const warnings: OperationScopeWarning[] = [];
  const security = scanOperationPlanSecurity(plan, securityOverride);
  for (const finding of security.findings) {
    warnings.push({
      code: "security_risk_detected",
      severity: finding.blocking ? "blocker" : "warning",
      message: `${finding.message} Evidence class: ${finding.evidence}. Treat command/file content as untrusted and verify before execution.`,
      details: {
        security_code: finding.code,
        evidence: finding.evidence,
        risk_level: security.risk_level,
        security_override_applied: security.security_override_applied === true,
      },
    });
  }
  if (!text.trim()) {
    warnings.push({
      code: "operation_scope_unmapped",
      severity: "warning",
      message:
        "No concrete operation intent, command, target, or file was provided. Provide the planned operation before executing so it can be checked against current constraints.",
    });
  }

  const planHasOperationWord = OPERATION_WORDS.some((word) => normalizeText(text).includes(normalizeText(word)));
  if (!planHasOperationWord && (plan.commands?.length || plan.targets?.length || plan.files?.length)) {
    warnings.push({
      code: "operation_scope_unmapped",
      severity: "info",
      message:
        "The plan includes commands/files/targets but does not clearly name the operation type. This is advisory only; add a concise operation label for better constraint matching.",
    });
  }

  for (const constraint of currentConstraints) {
    const conflict = classifyConstraintConflict(plan, constraint);
    if (conflict) warnings.push(conflict);
    const staleDefault = classifyStaleDefaultConflict(plan, constraint);
    if (staleDefault) warnings.push(staleDefault);
  }

  const deduped = new Map<string, OperationScopeWarning>();
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.evidence?.[0]?.constraint_id ?? ""}:${warning.message}`;
    const prev = deduped.get(key);
    if (!prev || (prev.severity !== "blocker" && warning.severity === "blocker")) deduped.set(key, warning);
  }
  const finalWarnings = Array.from(deduped.values());
  const blocking = finalWarnings.some((w) => w.severity === "blocker");
  return {
    ok: !blocking,
    safe_to_proceed: !blocking,
    read_only: true,
    advisory_only: true,
    enforcement_mode: "preflight_blocker",
    host_enforcement_required: true,
    security_override_applied: security.security_override_applied === true,
    does_not_control_model_reasoning: true,
    does_not_control_host_runtime: true,
    does_not_replace_model_judgment: true,
    operation: plan.operation,
    intent: plan.intent ?? "",
    planned_commands: plan.commands ?? [],
    planned_files: plan.files ?? [],
    planned_targets: plan.targets ?? [],
    current_constraints: currentConstraints,
    warnings: finalWarnings,
    recommended_action: blocking
      ? "Stop before executing. Align the operation with current constraints, choose a narrower target/command, or ask the user to explicitly expand or override the constraint."
      : finalWarnings.length
        ? "Proceed only after checking the warnings against the current user request and directly observed repository facts."
        : "No operation-scope conflicts detected from current constraints.",
  };
}

export function expandOperationQuery(query: string): string {
  const q = normalizeText(query);
  if (!OPERATION_WORDS.some((word) => q.includes(normalizeText(word)))) return query;
  const genericTerms = [
    "operation",
    "command",
    "script",
    "target",
    "default",
    "fallback",
    "current decision",
    "constraint",
    "convention",
    "执行",
    "命令",
    "脚本",
    "目标",
    "默认",
    "当前决策",
    "约束",
  ];
  return Array.from(new Set([query, ...genericTerms])).join(" ");
}
