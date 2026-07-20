import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { RtkDetection } from "./types.js";
import type { InstallRtkArgs } from "./tool-schemas.js";
import { RTK_COMMIT_SHA } from "./rtk-integrity.js";

type SecureRtkInstallMethod = "package_shim" | "cargo" | "brew" | "unavailable";

function oneLine(input: string | null | undefined, max = 120): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  if (process.platform === "win32") return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function getPackageRtkShimPath(): string | null {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(currentDir, "rtk-shim.js");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url may be unavailable only in unexpected runtimes.
  }
  return null;
}

function runRtkProbe(spec: {
  source: "path" | "package_shim";
  displayCommand: string;
  execCommand: string;
  execArgsPrefix?: string[];
  execShell?: boolean;
  execEnv?: NodeJS.ProcessEnv;
  path?: string;
}): RtkDetection | null {
  const argsPrefix = spec.execArgsPrefix ?? [];
  const env = { ...process.env, VECTORMIND_RTK_NO_AUTO_INSTALL: "1", ...(spec.execEnv ?? {}) };
  const result = spawnSync(spec.execCommand, [...argsPrefix, "--version"], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    shell: spec.execShell ?? false,
    env,
  });
  if (result.status === 0) {
    const gain = spawnSync(spec.execCommand, [...argsPrefix, "gain"], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      shell: spec.execShell ?? false,
      env,
    });
    let resolvedPath = spec.path;
    if (spec.source === "path") {
      const whereCommand = process.platform === "win32" ? "where.exe" : "which";
      const whereResult = spawnSync(whereCommand, ["rtk"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      resolvedPath = whereResult.status === 0 ? oneLine(whereResult.stdout, 240) : resolvedPath;
    }
    const gainText = `${gain.stdout}${gain.stderr}`.trim();
    return {
      available: gain.status === 0,
      command: spec.displayCommand,
      version: `${result.stdout}${result.stderr}`.trim(),
      gain_ok: gain.status === 0,
      gain_preview: oneLine(gainText, 240),
      path: resolvedPath,
      source: spec.source,
      exec_command: spec.execCommand,
      exec_args_prefix: argsPrefix,
      exec_shell: spec.execShell ?? false,
      note:
        gain.status === 0
          ? spec.source === "package_shim"
            ? `Prefer prefixing shell commands with ${spec.displayCommand} for compact outputs. This is VectorMind's bundled RTK shim; first run auto-installs/caches rtk-ai/rtk if needed.`
            : "Prefer prefixing shell commands with rtk for compact outputs, e.g. rtk git status / rtk npm run build / rtk rg pattern ."
          : spec.source === "package_shim"
            ? "VectorMind's bundled RTK shim exists, but `gain` failed. Check npm/cache or set VECTORMIND_RTK_REAL to an existing rtk-ai/rtk binary."
            : "An rtk binary exists, but `rtk gain` failed. This may be the wrong rtk project. Use install_rtk with uninstall_wrong_cargo_rtk=true only when you intentionally want to replace it.",
    };
  }
  return null;
}

export function detectRtk(): RtkDetection {
  const pathProbe = runRtkProbe({
    source: "path",
    displayCommand: "rtk",
    execCommand: "rtk",
    execShell: process.platform === "win32",
  });
  if (pathProbe?.available) return pathProbe;

  const shimPath = getPackageRtkShimPath();
  if (shimPath) {
    const displayCommand = `node ${shellQuoteArg(shimPath)}`;
    const shimProbe = runRtkProbe({
      source: "package_shim",
      displayCommand,
      execCommand: process.execPath,
      execArgsPrefix: [shimPath],
      execEnv: { VECTORMIND_RTK_NO_AUTO_INSTALL: "1" },
      path: shimPath,
    });
    if (shimProbe) return shimProbe;
  }

  if (pathProbe) return pathProbe;

  return {
    available: false,
    command: shimPath ? `node ${shellQuoteArg(shimPath)}` : "rtk",
    path: shimPath ?? undefined,
    source: shimPath ? "package_shim" : undefined,
    note: shimPath
      ? "rtk was not found on PATH, and VectorMind's bundled RTK shim could not verify rtk gain without auto-installing. VectorMind compact MCP output still works; use install_rtk(dry_run=false) explicitly or set VECTORMIND_RTK_REAL."
      : "rtk was not found on PATH and the package RTK shim is unavailable. VectorMind compact MCP output still works; install rtk explicitly to compact shell command output too.",
  };
}

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8", timeout: 2000, windowsHide: true });
  return result.status === 0;
}

function runInstallStep(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): {
  command: string;
  status: number | null;
  ok: boolean;
  output: string;
} {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    ok: result.status === 0,
    output: oneLine(output, 1200),
  };
}

function runDetectedRtkStep(detected: RtkDetection, args: string[], timeoutMs: number): {
  command: string;
  status: number | null;
  ok: boolean;
  output: string;
} {
  const execCommand = detected.exec_command ?? "rtk";
  const argsPrefix = detected.exec_args_prefix ?? [];
  const result = spawnSync(execCommand, [...argsPrefix, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: detected.exec_shell ?? (execCommand === "rtk" && process.platform === "win32"),
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    command: [detected.command, ...args].join(" "),
    status: result.status,
    ok: result.status === 0,
    output: oneLine(output, 1200),
  };
}

function appendRtkInitStep(
  steps: Array<{ command: string; status: number | null; ok: boolean; output: string }>,
  detected: RtkDetection,
  init: InstallRtkArgs["init"],
  timeoutMs: number,
): void {
  if (init === "none") return;
  if (init === "global_no_patch") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--no-patch"], timeoutMs));
  if (init === "global_auto_patch") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--auto-patch"], timeoutMs));
  if (init === "global_hook_only") {
    steps.push(runDetectedRtkStep(detected, ["init", "-g", "--hook-only", "--no-patch"], timeoutMs));
  }
  if (init === "local") steps.push(runDetectedRtkStep(detected, ["init"], timeoutMs));
  if (init === "codex_global") steps.push(runDetectedRtkStep(detected, ["init", "-g", "--codex"], timeoutMs));
  if (init === "codex_local") steps.push(runDetectedRtkStep(detected, ["init", "--codex"], timeoutMs));
}

function chooseRtkInstallMethod(method: "auto" | "cargo" | "brew" | "shell_script"): SecureRtkInstallMethod {
  const shimPath = getPackageRtkShimPath();
  if (method === "cargo" || method === "brew") return method;
  if (method === "shell_script") {
    if (shimPath) return "package_shim";
    if (commandExists("cargo")) return "cargo";
    return "unavailable";
  }
  if (shimPath) return "package_shim";
  if (process.platform === "darwin" && commandExists("brew")) return "brew";
  if (commandExists("cargo")) return "cargo";
  return "unavailable";
}

export function buildRtkInstallPlan(args: InstallRtkArgs): {
  method: SecureRtkInstallMethod;
  shimPath: string | null;
  commands: string[];
  notes: string[];
} {
  const method = chooseRtkInstallMethod(args.method);
  const shimPath = getPackageRtkShimPath();
  const commands: string[] = [];
  const notes: string[] = [];

  if (args.uninstall_wrong_cargo_rtk) {
    commands.push("cargo uninstall rtk");
    notes.push("Only use uninstall_wrong_cargo_rtk after verifying the existing rtk is the wrong Cargo package.");
  }

  if (method === "brew") {
    commands.push("brew install rtk");
  } else if (method === "cargo") {
    commands.push(`cargo install --locked --git https://github.com/rtk-ai/rtk --rev ${RTK_COMMIT_SHA}`);
  } else if (method === "package_shim" && shimPath) {
    commands.push(`${shellQuoteArg(process.execPath)} ${shellQuoteArg(shimPath)} --version`);
    notes.push("The bundled RTK shim installs a pinned release asset only after SHA-256 verification.");
  } else {
    notes.push("No verified package shim, Cargo, or Homebrew installer is available. Refusing to execute a mutable remote shell script.");
  }

  const verifyCommand = method === "package_shim" && shimPath
    ? `${shellQuoteArg(process.execPath)} ${shellQuoteArg(shimPath)}`
    : "rtk";
  if (method !== "unavailable") {
    if (method !== "package_shim") commands.push(`${verifyCommand} --version`);
    commands.push(`${verifyCommand} gain`);
  }

  if (method !== "unavailable") {
    if (args.init === "global_no_patch") commands.push(`${verifyCommand} init -g --no-patch`);
    if (args.init === "global_auto_patch") commands.push(`${verifyCommand} init -g --auto-patch`);
    if (args.init === "global_hook_only") commands.push(`${verifyCommand} init -g --hook-only --no-patch`);
    if (args.init === "local") commands.push(`${verifyCommand} init`);
    if (args.init === "codex_global") commands.push(`${verifyCommand} init -g --codex`);
    if (args.init === "codex_local") commands.push(`${verifyCommand} init --codex`);
  } else if (args.init !== "none") {
    notes.push("RTK init cannot run because no verified installer is available.");
  }

  if (args.init !== "none") {
    notes.push("rtk init may modify Claude/RTK configuration. Use init=none for binary-only installation.");
  }

  return { method, shimPath, commands, notes };
}

export function installRtk(args: InstallRtkArgs): {
  ok: boolean;
  dry_run: boolean;
  already_available: boolean;
  method: string;
  commands: string[];
  notes: string[];
  steps: Array<{ command: string; status: number | null; ok: boolean; output: string }>;
  detected_before: ReturnType<typeof detectRtk>;
  detected_after?: ReturnType<typeof detectRtk>;
} {
  const detectedBefore = detectRtk();
  const plan = buildRtkInstallPlan(args);
  const steps: Array<{ command: string; status: number | null; ok: boolean; output: string }> = [];
  const notes = [...plan.notes];

  if (detectedBefore.available) {
    notes.push("rtk is already installed and verified with `rtk gain`; installation skipped.");
    if (!args.dry_run && args.init !== "none") {
      appendRtkInitStep(steps, detectedBefore, args.init, args.timeout_ms);
    }
    return {
      ok: true,
      dry_run: args.dry_run,
      already_available: true,
      method: plan.method,
      commands: plan.commands,
      notes,
      steps,
      detected_before: detectedBefore,
      detected_after: detectedBefore,
    };
  }

  if (args.dry_run) {
    notes.push("dry_run=true: no command was executed. Call install_rtk with dry_run=false to install.");
    return {
      ok: plan.method !== "unavailable",
      dry_run: true,
      already_available: false,
      method: plan.method,
      commands: plan.commands,
      notes,
      steps,
      detected_before: detectedBefore,
    };
  }

  if (args.uninstall_wrong_cargo_rtk) {
    steps.push(runInstallStep("cargo", ["uninstall", "rtk"], args.timeout_ms));
  }

  if (plan.method === "package_shim" && plan.shimPath) {
    steps.push(runInstallStep(
      process.execPath,
      [plan.shimPath, "--version"],
      args.timeout_ms,
      { ...process.env, VECTORMIND_RTK_NO_AUTO_INSTALL: "0" },
    ));
  } else if (plan.method === "brew") {
    steps.push(runInstallStep("brew", ["install", "rtk"], args.timeout_ms));
  } else if (plan.method === "cargo") {
    steps.push(runInstallStep(
      "cargo",
      ["install", "--locked", "--git", "https://github.com/rtk-ai/rtk", "--rev", RTK_COMMIT_SHA],
      args.timeout_ms,
    ));
  } else {
    notes.push("Installation was not attempted because no verified installer is available.");
  }

  const detectedAfterInstall = detectRtk();
  if (detectedAfterInstall.available && args.init !== "none") {
    appendRtkInitStep(steps, detectedAfterInstall, args.init, args.timeout_ms);
  }

  const detectedAfter = detectRtk();
  return {
    ok: detectedAfter.available,
    dry_run: false,
    already_available: false,
    method: plan.method,
    commands: plan.commands,
    notes,
    steps,
    detected_before: detectedBefore,
    detected_after: detectedAfter,
  };
}

export function compactInstallRtkText(data: ReturnType<typeof installRtk>): string {
  const lines: string[] = [];
  lines.push(
    `install_rtk ok=${data.ok} dry_run=${data.dry_run} already_available=${data.already_available} method=${data.method}`,
  );
  lines.push(
    `before available=${data.detected_before.available} version=${data.detected_before.version ?? "none"} gain_ok=${data.detected_before.gain_ok ?? false}`,
  );
  if (data.detected_after) {
    lines.push(
      `after available=${data.detected_after.available} version=${data.detected_after.version ?? "none"} gain_ok=${data.detected_after.gain_ok ?? false}`,
    );
  }
  if (data.commands.length) {
    lines.push("commands:");
    for (const command of data.commands) lines.push(`- ${command}`);
  }
  if (data.steps.length) {
    lines.push("steps:");
    for (const step of data.steps) {
      lines.push(`- ${step.ok ? "ok" : "fail"} [${step.status ?? "null"}] ${step.command}: ${oneLine(step.output, 240)}`);
    }
  }
  if (data.notes.length) {
    lines.push("notes:");
    for (const note of data.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}
