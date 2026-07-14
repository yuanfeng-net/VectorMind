import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { RootSource } from "./types.js";

const rootFromEnv = process.env.VECTORMIND_ROOT?.trim() ?? "";
function getCodexHomeDir(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".codex");
}
function getAgentsHomeDir(): string {
  const raw = process.env.AGENTS_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".agents");
}

export function getAllowedCodexTextRoots(): string[] {
  const codexHome = getCodexHomeDir();
  const agentsHome = getAgentsHomeDir();
  return Array.from(
    new Set(
      [
        path.join(codexHome, "skills"),
        path.join(codexHome, "prompts"),
        path.join(codexHome, "rules"),
        path.join(agentsHome, "skills"),
      ].map((p) => path.resolve(p)),
    ),
  );
}

export function isProbablyVscodeInstallDir(dir: string): boolean {
  const normalized = path.resolve(dir).toLowerCase().replace(/\\/g, "/");
  return normalized.endsWith("/microsoft vs code") || normalized.includes("/microsoft vs code/resources/app");
}

export function isProbablySystemDir(dir: string): boolean {
  const normalized = path.resolve(dir).toLowerCase().replace(/\\/g, "/");
  const sysRootRaw = process.env.SystemRoot?.trim();
  const sysRoot = sysRootRaw ? path.resolve(sysRootRaw).toLowerCase().replace(/\\/g, "/") : "";
  const home = os.homedir().toLowerCase().replace(/\\/g, "/");

  if (normalized === "/" || /^[a-z]:\/?$/.test(normalized)) return true;
  if (sysRoot && (normalized === sysRoot || normalized.startsWith(`${sysRoot}/system32`))) return true;
  if (normalized === home) return true;
  if (normalized.endsWith("/appdata/roaming/code/user")) return true;
  if (normalized.endsWith("/appdata/roaming/cursor/user")) return true;
  if (normalized.endsWith("/appdata/roaming/windsurf/user")) return true;
  if (normalized.endsWith("/.vscode/extensions")) return true;
  for (const programDir of [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["ProgramW6432"],
  ]) {
    if (!programDir) continue;
    const p = path.resolve(programDir).toLowerCase().replace(/\\/g, "/");
    if (normalized === p || normalized.startsWith(`${p}/`)) return true;
  }
  return false;
}
function getVsCodeUserDirCandidate(): string | null {
  try {
    const appData = process.env.APPDATA?.trim();
    if (process.platform === "win32") {
      const roaming = appData || path.join(os.homedir(), "AppData", "Roaming");
      return path.join(roaming, "Code", "User");
    }
    if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
    }
    return path.join(os.homedir(), ".config", "Code", "User");
  } catch {
    return null;
  }
}

export function resolveSafeFallbackRootDir(): string {
  const candidate = getVsCodeUserDirCandidate();
  if (candidate) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // fall through
    }
  }
  return os.homedir();
}

export function parseFileUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(new URL(uri));
  } catch {
    return null;
  }
}
function isProjectRootMarkerPresent(dir: string): boolean {
  const markers = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "npm-shrinkwrap.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "deno.json",
    "deno.jsonc",
    "composer.json",
    "Gemfile",
  ];
  for (const marker of markers) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some((e) => e.endsWith(".sln"))) return true;
  } catch {
    // ignore
  }
  return false;
}
function findNearestVectorMindRoot(startDir: string): string | null {
  let current = fs.existsSync(startDir) && fs.statSync(startDir).isFile()
    ? path.dirname(startDir)
    : startDir;
  current = path.resolve(current);
  for (;;) {
    const vmDir = path.join(current, ".vectormind");
    if (fs.existsSync(path.join(vmDir, "vectormind.db")) || fs.existsSync(vmDir)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function findNearestProjectRoot(startDir: string): string {
  let current = fs.existsSync(startDir) && fs.statSync(startDir).isFile()
    ? path.dirname(startDir)
    : startDir;
  current = path.resolve(current);
  for (;;) {
    if (isProjectRootMarkerPresent(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRootFromToolArgOrThrow(
  raw: unknown,
  options: { preferred_root?: string; mode?: "canonical" | "exact" } = {},
): { root: string; source: RootSource } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fileUriPath = trimmed.startsWith("file://") ? parseFileUriToPath(trimmed) : null;
  const base = fileUriPath ?? trimmed;
  const abs = path.resolve(base);
  const resolveCandidate = (candidate: string): string => {
    const exactRoot = findNearestProjectRoot(candidate);
    if (options.mode === "exact" || !options.preferred_root) return exactRoot;
    const preferredRoot = path.resolve(options.preferred_root);
    if (!isPathWithin(preferredRoot, candidate)) return exactRoot;
    const nestedVectorMindRoot = findNearestVectorMindRoot(candidate);
    if (nestedVectorMindRoot && path.resolve(nestedVectorMindRoot) !== preferredRoot) {
      return nestedVectorMindRoot;
    }
    return preferredRoot;
  };
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { root: resolveCandidate(abs), source: "tool_arg" };
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return { root: resolveCandidate(abs), source: "tool_arg" };
    }
    const parent = path.dirname(abs);
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
      return { root: resolveCandidate(parent), source: "tool_arg" };
    }
  } catch (err) {
    throw new Error(`[VectorMind] Invalid project_root: ${abs}. (${String(err)})`);
  }
  throw new Error(`[VectorMind] project_root does not exist: ${abs}`);
}

export function resolveRootFromEnvOrThrow(): { root: string; source: RootSource } | null {
  if (!rootFromEnv) return null;
  const abs = path.resolve(rootFromEnv);
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return { root: findNearestProjectRoot(abs), source: "env" };
    }
    throw new Error("not an existing directory");
  } catch (err) {
    throw new Error(
      `[VectorMind] Invalid VECTORMIND_ROOT: ${abs}. Set it to an existing project directory. (${String(err)})`,
    );
  }
}

export function normalizeToDbPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/");
  if (!normalized || normalized === ".") return ".";
  return path.posix.normalize(normalized).replace(/^\.\/+/, "");
}
