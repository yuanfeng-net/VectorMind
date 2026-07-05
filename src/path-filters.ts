export function normalizePathNeedle(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

export function passesPathFilters(filePath: string, includePaths: string[] | null, excludePaths: string[] | null): boolean {
  const fp = filePath.toLowerCase();

  if (excludePaths?.length) {
    for (const raw of excludePaths) {
      const n = normalizePathNeedle(raw);
      if (!n) continue;
      if (fp.includes(n)) return false;
    }
  }

  if (includePaths?.length) {
    for (const raw of includePaths) {
      const n = normalizePathNeedle(raw);
      if (!n) continue;
      if (fp.includes(n)) return true;
    }
    return false;
  }

  return true;
}
