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

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function focusedQueryTokens(query: string): string[] {
  const normalized = normalizeSearchText(query);
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9_./:@#-]{2,}/g) ?? []) {
    if (!QUERY_STOPWORDS.has(token)) tokens.add(token);
    for (const part of token.split(/[^a-z0-9]+/).filter((item) => item.length >= 3)) {
      if (!QUERY_STOPWORDS.has(part)) tokens.add(part);
    }
  }
  for (const sequence of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length >= 2) tokens.add(sequence);
    for (const width of [2, 3, 4]) {
      for (let index = 0; index <= sequence.length - width; index += 1) {
        tokens.add(sequence.slice(index, index + width));
      }
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length).slice(0, 40);
}

function focusedMatchIsRelevant(query: string, match: SemanticMatchLike): boolean {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return false;
  const haystack = normalizeSearchText([
    match.item.title ?? "",
    match.item.preview ?? "",
    match.item.file_path ?? "",
  ].join("\n"));
  if (haystack.includes(normalizedQuery)) return true;

  const tokens = focusedQueryTokens(query);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => haystack.includes(token));
  const strongTokens = tokens.filter((token) =>
    /\d/.test(token) ||
    token.length >= 8 ||
    (/\p{Script=Han}/u.test(token) && token.length >= 4),
  );
  if (strongTokens.some((token) => haystack.includes(token))) return true;

  const requiredMatches = tokens.length <= 2 ? 1 : 2;
  return matched.length >= requiredMatches && matched.length / tokens.length >= 0.3;
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
  const normalize = (value: string | null | undefined) =>
    (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
  if (activeTitle === nextTitle && activeBackground === nextBackground) return true;

  const tokens = (value: string): Set<string> => {
    const result = new Set(value.match(/[a-z0-9_./:@#-]{2,}/g) ?? []);
    const compact = value.replace(/\s+/g, "");
    for (const sequence of compact.match(/\p{Script=Han}+/gu) ?? []) {
      for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2));
    }
    return result;
  };
  const similarity = (left: string, right: string): number => {
    const a = tokens(left);
    const b = tokens(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap += 1;
    return (2 * overlap) / (a.size + b.size);
  };
  const titleSimilarity = similarity(activeTitle, nextTitle);
  const backgroundSimilarity = similarity(activeBackground, nextBackground);
  const titleContains = Math.min(activeTitle.length, nextTitle.length) >= 8 &&
    (activeTitle.includes(nextTitle) || nextTitle.includes(activeTitle));
  return (titleSimilarity >= 0.78 || titleContains) &&
    (!activeBackground || !nextBackground || backgroundSimilarity >= 0.55);
}

export function normalizeRequirementGoalIdentity(title: string, background?: string | null): string {
  return `${title}\n${background ?? ""}`.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
