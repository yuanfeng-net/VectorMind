import fs from "node:fs";
import path from "node:path";

export type ResolvePathWithinRootOptions = {
  allowMissing?: boolean;
};

function comparisonPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const root = comparisonPath(rootPath);
  const target = comparisonPath(targetPath);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateExistingComponents(rootAbs: string, rootReal: string, candidateAbs: string): void {
  const relative = path.relative(rootAbs, candidateAbs);
  let current = rootAbs;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    let currentReal: string;
    try {
      currentReal = fs.realpathSync.native(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`[VectorMind] Path contains an unresolved link or invalid component: ${candidateAbs}`);
      }
      throw error;
    }
    if (!isPathWithinRoot(rootReal, currentReal)) {
      throw new Error(`[VectorMind] Path resolves outside the allowed root: ${candidateAbs}`);
    }
  }
}

export function resolvePathWithinRoot(
  rootPath: string,
  inputPath: string,
  options: ResolvePathWithinRootOptions = {},
): string {
  const rootAbs = path.resolve(rootPath);
  const candidateAbs = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(rootAbs, inputPath));
  if (!isPathWithinRoot(rootAbs, candidateAbs)) {
    throw new Error(`[VectorMind] Path must be under the allowed root: ${inputPath}`);
  }

  const rootReal = fs.realpathSync.native(rootAbs);
  try {
    const candidateReal = fs.realpathSync.native(candidateAbs);
    if (!isPathWithinRoot(rootReal, candidateReal)) {
      throw new Error(`[VectorMind] Path resolves outside the allowed root: ${inputPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!options.allowMissing || (code !== "ENOENT" && code !== "ENOTDIR")) throw error;
    validateExistingComponents(rootAbs, rootReal, candidateAbs);
  }

  return candidateAbs;
}
