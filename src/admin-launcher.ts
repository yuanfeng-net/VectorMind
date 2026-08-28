import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const registeredProjects = new Set<string>();

export type AdminLaunchResult = {
  started: boolean;
  reason: "started" | "disabled" | "missing_entry" | "spawn_failed";
  entry: string;
  url: string;
  pid?: number;
};

export function adminPanelAutoStartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !FALSE_VALUES.has((env.VECTORMIND_ADMIN_AUTO_START ?? "").trim().toLowerCase());
}

export function adminPanelEntry(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "admin-panel", "server", "index.mjs");
}

function adminConnectHost(host: string): string {
  const normalized = host.trim().replace(/^\[|\]$/gu, "").toLowerCase();
  if (!normalized || ["0.0.0.0", "127.0.0.1"].includes(normalized)) return "127.0.0.1";
  if (normalized === "localhost") return "localhost";
  if (["::", "::1"].includes(normalized)) return "[::1]";
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function adminPort(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.VECTORMIND_ADMIN_PORT ?? "16860", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 16860;
}

function adminUrl(env: NodeJS.ProcessEnv): string {
  return `http://${adminConnectHost(env.VECTORMIND_ADMIN_HOST ?? "127.0.0.1")}:${adminPort(env)}`;
}

export function startAdminPanelIfEnabled(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  moduleUrl?: string;
  detached?: boolean;
} = {}): AdminLaunchResult {
  const env = options.env ?? process.env;
  const entry = adminPanelEntry(options.moduleUrl);
  const url = adminUrl(env);
  if (!adminPanelAutoStartEnabled(env)) return { started: false, reason: "disabled", entry, url };
  if (!fs.existsSync(entry)) return { started: false, reason: "missing_entry", entry, url };
  try {
    const projectHint = env.VECTORMIND_ROOT?.trim() || options.cwd || process.cwd();
    const detached = options.detached !== false;
    const child = spawn(process.execPath, [entry, "--production", "--auto-started"], {
      cwd: options.cwd ?? process.cwd(),
      detached,
      env: { ...env, VECTORMIND_ADMIN_PROJECT_ROOT: projectHint },
      stdio: "ignore",
      windowsHide: true,
    });
    if (detached) child.unref();
    return { started: true, reason: "started", entry, url, ...(child.pid ? { pid: child.pid } : {}) };
  } catch {
    return { started: false, reason: "spawn_failed", entry, url };
  }
}

async function registerProjectOnce(projectRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const baseUrl = adminUrl(env);
  const configResponse = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(750) });
  if (!configResponse.ok) return false;
  const config = await configResponse.json() as { sessionToken?: string };
  const token = env.VECTORMIND_ADMIN_TOKEN?.trim() || config.sessionToken;
  if (!token) return false;
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vectormind-admin-token": token,
    },
    body: JSON.stringify({ path: projectRoot }),
    signal: AbortSignal.timeout(1_000),
  });
  return response.ok;
}

export function scheduleAdminProjectRegistration(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!adminPanelAutoStartEnabled(env)) return;
  const resolved = path.resolve(projectRoot);
  if (registeredProjects.has(resolved)) return;
  registeredProjects.add(resolved);
  const delays = [100, 500, 1_500];
  const attempt = async (index: number): Promise<void> => {
    try {
      if (await registerProjectOnce(resolved, env)) return;
    } catch {
      // The panel may still be starting or may be intentionally unavailable.
    }
    if (index + 1 >= delays.length) {
      registeredProjects.delete(resolved);
      return;
    }
    const timer = setTimeout(() => void attempt(index + 1), delays[index + 1]);
    timer.unref();
  };
  const timer = setTimeout(() => void attempt(0), delays[0]);
  timer.unref();
}
