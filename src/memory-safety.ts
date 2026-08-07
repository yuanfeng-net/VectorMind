export type MemorySanitization = {
  text: string;
  redacted: boolean;
  categories: string[];
};

export type MemoryValueSanitization<T> = {
  value: T;
  redacted: boolean;
  categories: string[];
};

const SECRET_KEY_SUFFIX = String.raw`(?:password|passwd|pwd|secret(?:[_-]?key)?|api[_-]?key|access[_-]?token|auth[_-]?token|bot[_-]?token|private[_-]?key)`;
const SECRET_KEY = String.raw`(?:[A-Za-z][A-Za-z0-9.-]*[_-])*${SECRET_KEY_SUFFIX}`;
const SECRET_KEY_ONLY = new RegExp(`^(?:${SECRET_KEY})$`, "iu");

export function sanitizePersistentMemoryText(value: string): MemorySanitization {
  const categories = new Set<string>();
  let text = value;
  const replace = (pattern: RegExp, category: string, replacer: (...args: string[]) => string) => {
    text = text.replace(pattern, (...args) => {
      categories.add(category);
      return replacer(...(args as string[]));
    });
  };

  replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
    "private_key",
    () => "[REDACTED PRIVATE KEY]",
  );
  replace(
    new RegExp(`("${SECRET_KEY}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "giu"),
    "named_secret",
    (_match, prefix) => `${prefix}"[REDACTED]"`,
  );
  replace(
    new RegExp(`((?<![A-Za-z0-9_.-])${SECRET_KEY}(?![A-Za-z0-9_.-])\\s*(?:=|:)\\s*)"[^"\\r\\n]*"`, "giu"),
    "named_secret",
    (_match, prefix) => `${prefix}"[REDACTED]"`,
  );
  replace(
    new RegExp(`((?<![A-Za-z0-9_.-])${SECRET_KEY}(?![A-Za-z0-9_.-])\\s*(?:=|:)\\s*)'[^'\\r\\n]*'`, "giu"),
    "named_secret",
    (_match, prefix) => `${prefix}'[REDACTED]'`,
  );
  replace(
    new RegExp(`((?<![A-Za-z0-9_.-])${SECRET_KEY}(?![A-Za-z0-9_.-])\\s*(?:=|:)\\s*)([^\"'\\s,;}\\]]+)`, "giu"),
    "named_secret",
    (_match, prefix) => `${prefix}[REDACTED]`,
  );
  replace(
    /(authorization\s*(?:=|:)\s*(?:bearer|basic)\s+)([^\s,;]+)/giu,
    "authorization",
    (_match, prefix) => `${prefix}[REDACTED]`,
  );
  replace(
    /\b(?:sk|gms|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/gu,
    "token",
    () => "[REDACTED TOKEN]",
  );
  replace(
    /\b\d{6,12}:[A-Za-z0-9_-]{24,}\b/gu,
    "bot_token",
    () => "[REDACTED BOT TOKEN]",
  );
  replace(
    /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu,
    "url_credentials",
    (_match, scheme) => `${scheme}[REDACTED]@`,
  );

  return { text, redacted: categories.size > 0, categories: [...categories].sort() };
}

export function sanitizePersistentMemoryValue<T>(input: T): MemoryValueSanitization<T> {
  const categories = new Set<string>();
  let redacted = false;
  const visit = (value: unknown, key?: string): unknown => {
    if (key && SECRET_KEY_ONLY.test(key) && value != null) {
      redacted = true;
      categories.add("named_secret");
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      const result = sanitizePersistentMemoryText(value);
      if (result.redacted) redacted = true;
      for (const category of result.categories) categories.add(category);
      return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey),
        ]),
      );
    }
    return value;
  };
  return { value: visit(input) as T, redacted, categories: [...categories].sort() };
}

export function sanitizePersistentMemoryStrings(values: string[] | undefined): {
  values: string[];
  redacted: boolean;
  categories: string[];
} {
  const results = (values ?? []).map(sanitizePersistentMemoryText);
  return {
    values: results.map((result) => result.text),
    redacted: results.some((result) => result.redacted),
    categories: [...new Set(results.flatMap((result) => result.categories))].sort(),
  };
}
