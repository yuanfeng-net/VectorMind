export type BootstrapContextMode = "focused" | "full";

export type BootstrapContextPolicy = {
  mode: BootstrapContextMode;
  include_pending: boolean;
  include_recent: boolean;
  max_output_chars: number;
};

type SemanticMatchLike = {
  item: {
    title?: string | null;
    preview?: string | null;
    file_path?: string | null;
  };
};

const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "with", "what", "why", "how",
  "smoke", "test", "context", "current", "please", "check", "verify",
]);

const OPERATION_INTENT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "deploy", pattern: /部署|发布|上线|\bdeploy(?:ment)?\b|\bpublish\b|\brelease\b/iu },
  { label: "build", pattern: /构建|编译|打包|\bbuild\b|\bcompile\b|\bpackage\b/iu },
  { label: "test", pattern: /运行测试|执行测试|测试命令|\b(?:run|execute)\s+(?:the\s+)?tests?\b|\b(?:pytest|vitest|jest)\b/iu },
  { label: "migrate", pattern: /数据库迁移|迁移数据库|\bmigrat(?:e|ion)\b/iu },
  { label: "service", pattern: /启动服务|停止服务|重启服务|\b(?:start|stop|restart)\s+(?:the\s+)?service\b/iu },
  { label: "git", pattern: /提交并推送|推送代码|拉取代码|合并分支|创建提交|\bgit\s+(?:commit|push|pull|merge|rebase|tag)\b/iu },
  { label: "dependencies", pattern: /安装依赖|升级依赖|\b(?:npm|pnpm|yarn|pip|uv|cargo)\s+(?:install|add|update|upgrade)\b/iu },
  { label: "rollback", pattern: /回滚|\brollback\b/iu },
  { label: "container", pattern: /\bdocker(?:\s+compose)?\b|\bkubectl\b|\bhelm\b/iu },
  { label: "command", pattern: /\b(?:npm|pnpm|yarn)\s+run\b|\bdotnet\s+(?:build|test|run|publish)\b|\bgo\s+(?:test|run|build)\b|\bcargo\s+(?:test|run|build)\b/iu },
];

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function detectOperationIntent(value: string): {
  detected: boolean;
  matched_terms: string[];
} {
  const normalized = normalizeSearchText(value);
  const matched_terms = OPERATION_INTENT_PATTERNS
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ label }) => label);
  return { detected: matched_terms.length > 0, matched_terms };
}

export function isObviouslyCorruptedText(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => {
    const compact = (value ?? "").replace(/\s+/g, "");
    if (!compact) return false;
    if (compact.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(compact)) return true;
    const questionMarks = compact.match(/\?/g)?.length ?? 0;
    return questionMarks >= 4 && questionMarks / compact.length >= 0.2;
  });
}

function focusedEvidenceCoverage(query: string, haystack: string): {
  total_chars: number;
  matched_chars: number;
  coverage: number;
  independent_runs: number;
  distinct_terms: number;
  technical_anchor: boolean;
} {
  const segments = normalizeSearchText(query).match(/[a-z0-9_./:@#-]+|\p{Script=Han}+/gu) ?? [];
  let totalChars = 0;
  let matchedChars = 0;
  let independentRuns = 0;
  const distinctTerms = new Set<string>();
  let technicalAnchor = false;

  for (const segment of segments) {
    if (/^[a-z0-9_./:@#-]+$/.test(segment)) {
      if (QUERY_STOPWORDS.has(segment)) continue;
      totalChars += segment.length;
      if (!haystack.includes(segment)) continue;
      matchedChars += segment.length;
      independentRuns += 1;
      distinctTerms.add(segment);
      if (segment.length >= 3 && (/\d/.test(segment) || /[_.\/@:#-]/.test(segment))) {
        technicalAnchor = true;
      }
      continue;
    }

    totalChars += segment.length;
    const covered = Array.from({ length: segment.length }, () => false);
    const maxWidth = Math.min(6, segment.length);
    for (let width = maxWidth; width >= 2; width -= 1) {
      for (let index = 0; index <= segment.length - width; index += 1) {
        if (!haystack.includes(segment.slice(index, index + width))) continue;
        distinctTerms.add(segment.slice(index, index + width));
        for (let offset = index; offset < index + width; offset += 1) covered[offset] = true;
      }
    }
    matchedChars += covered.filter(Boolean).length;
    for (let index = 0; index < covered.length; index += 1) {
      if (covered[index] && (index === 0 || !covered[index - 1])) independentRuns += 1;
    }
  }

  return {
    total_chars: totalChars,
    matched_chars: matchedChars,
    coverage: totalChars > 0 ? matchedChars / totalChars : 0,
    independent_runs: independentRuns,
    distinct_terms: distinctTerms.size,
    technical_anchor: technicalAnchor,
  };
}

export function focusedTextIsRelevant(
  query: string,
  ...values: Array<string | null | undefined>
): boolean {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return false;
  if (isObviouslyCorruptedText(...values)) return false;
  const haystack = normalizeSearchText(values.filter(Boolean).join("\n"));
  if (haystack.includes(normalizedQuery)) return true;

  const evidence = focusedEvidenceCoverage(query, haystack);
  if (evidence.technical_anchor) return true;
  if (evidence.total_chars <= 4) return evidence.coverage === 1;
  if (evidence.distinct_terms < 2) return false;
  return evidence.coverage >= 0.58 ||
    (evidence.coverage >= 0.42 && evidence.matched_chars >= 6 && evidence.independent_runs >= 2) ||
    (evidence.matched_chars >= 8 && evidence.independent_runs >= 3 && evidence.distinct_terms >= 3);
}

function focusedMatchIsRelevant(query: string, match: SemanticMatchLike): boolean {
  return focusedTextIsRelevant(
    query,
    match.item.title,
    match.item.preview,
    match.item.file_path,
  );
}

export function filterFocusedSemanticResult<T extends { matches: SemanticMatchLike[] }>(
  query: string,
  result: T | null,
): (T & { focused_fallback?: boolean; focused_no_match?: boolean }) | null {
  if (!result) return null;
  const matches = result.matches.filter((match) => focusedMatchIsRelevant(query, match));
  return {
    ...result,
    matches,
    focused_fallback: false,
    focused_no_match: matches.length === 0,
  };
}

function hasOwn(rawArgs: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rawArgs, key);
}

export function resolveBootstrapContextPolicy(
  rawArgs: Record<string, unknown>,
  args: {
    context_mode: BootstrapContextMode;
    include_pending: boolean;
    include_recent: boolean;
    max_output_chars: number;
  },
): BootstrapContextPolicy {
  const explicitRecentLimits = [
    "requirements_limit",
    "changes_limit",
    "notes_limit",
    "conventions_limit",
    "decisions_limit",
    "current_context_limit",
  ].some((key) => hasOwn(rawArgs, key));

  return {
    mode: args.context_mode,
    include_pending:
      args.context_mode === "full" ||
      args.include_pending ||
      hasOwn(rawArgs, "pending_limit") ||
      hasOwn(rawArgs, "pending_offset"),
    include_recent:
      args.context_mode === "full" ||
      args.include_recent ||
      explicitRecentLimits,
    max_output_chars: args.max_output_chars,
  };
}

export function boundCompactContext(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };

  const suffix = "\ncontext budget: truncated; use targeted read_memory_item or format=json only when required";
  const available = Math.max(0, maxChars - suffix.length);
  const candidate = text.slice(0, available);
  const lastLineBreak = candidate.lastIndexOf("\n");
  const bounded = (lastLineBreak >= Math.floor(available * 0.6)
    ? candidate.slice(0, lastLineBreak)
    : candidate
  ).trimEnd();
  return { text: `${bounded}${suffix}`, truncated: true };
}

export function sameRequirement(
  active: { title: string; context_data?: string | null; goal_key?: string | null },
  next: { title: string; background?: string | null; goal_key?: string | null },
): boolean {
  const normalize = normalizeRequirementText;
  const activeGoalKey = normalize(active.goal_key);
  const nextGoalKey = normalize(next.goal_key);
  if (activeGoalKey && nextGoalKey) {
    if (activeGoalKey === nextGoalKey) return true;
    if (!activeGoalKey.startsWith("auto:") || !nextGoalKey.startsWith("auto:")) return false;
  }

  const activeTitle = normalize(active.title);
  const nextTitle = normalize(next.title);
  const activeBackground = normalize(active.context_data);
  const nextBackground = normalize(next.background);
  return activeTitle === nextTitle && activeBackground === nextBackground;
}

const REQUIREMENT_STOP_WORDS = new Set([
  "after", "before", "build", "change", "continue", "debug", "deploy", "ensure", "fix", "implement",
  "issue", "problem", "requirement", "the", "this", "update", "with", "修复", "实现", "继续", "问题", "需求",
]);

function requirementTerms(value: string | null | undefined): Set<string> {
  const normalized = normalizeRequirementText(value);
  const raw = normalized.match(/[a-z0-9_./:@#-]{3,}|\p{Script=Han}{2,}/gu) ?? [];
  const expanded = raw.flatMap((term) => {
    if (!/\p{Script=Han}/u.test(term) || term.length <= 2) return [term];
    return Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2));
  });
  return new Set(expanded.filter((term) => !REQUIREMENT_STOP_WORDS.has(term)));
}

export function requirementOverlapScore(
  active: { title: string; context_data?: string | null },
  next: { title: string; background?: string | null },
): number {
  const left = requirementTerms(`${active.title}\n${active.context_data ?? ""}`);
  const right = requirementTerms(`${next.title}\n${next.background ?? ""}`);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((term) => right.has(term));
  if (!shared.length) return 0;
  const structuredAnchor = shared.some((term) => /[0-9_./:@#-]/u.test(term));
  const sharedHanTerms = shared.filter((term) => /\p{Script=Han}/u.test(term));
  if (!structuredAnchor && shared.length < 2 && sharedHanTerms.length < 2) return 0;
  const containment = shared.length / Math.min(left.size, right.size);
  const jaccard = shared.length / new Set([...left, ...right]).size;
  const hanEvidence = sharedHanTerms.length >= 4
    ? Math.min(0.8, 0.4 + sharedHanTerms.length * 0.04)
    : 0;
  return Math.min(1, Math.max(jaccard, containment * (structuredAnchor ? 1 : 0.8), hanEvidence));
}

function normalizeRequirementText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function sameRootRequirement(
  active: { title: string; context_data?: string | null; goal_key?: string | null },
  next: { title: string; background?: string | null; goal_key?: string | null },
): boolean {
  return sameRequirement(active, next);
}

export function normalizeRequirementGoalIdentity(title: string, background?: string | null): string {
  return `${title}\n${background ?? ""}`.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
