function normalizePathNeedle(s: string, platform: NodeJS.Platform): string {
  const normalized = s.replace(/\\/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function passesPathFilters(
  filePath: string,
  includePaths: string[] | null,
  excludePaths: string[] | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fp = normalizePathNeedle(filePath, platform);

  if (excludePaths?.length) {
    for (const raw of excludePaths) {
      const n = normalizePathNeedle(raw, platform);
      if (!n) continue;
      if (fp.includes(n)) return false;
    }
  }

  if (includePaths?.length) {
    for (const raw of includePaths) {
      const n = normalizePathNeedle(raw, platform);
      if (!n) continue;
      if (fp.includes(n)) return true;
    }
    return false;
  }

  return true;
}
