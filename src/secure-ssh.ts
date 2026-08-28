import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { resolvePathWithinRoot } from "./path-containment.js";

export type SecureSshPreparation = {
  ok: true;
  status: "ready" | "key_installation_required";
  target: { host: string; user: string; port: number };
  ssh_config_path: string;
  identity_file: string;
  public_key?: string;
  fingerprint?: string;
  generated_key: boolean;
  password_authentication_disabled: true;
  sensitive_fields_detected: string[];
  note: string;
};

type ParsedSshSource = {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  sensitiveFields: Set<string>;
};

export type ConfiguredSshTarget = {
  host: string;
  port: number;
};

export type PreparedSshTargetReference = {
  alias: "vectormind-target";
  host: string;
  ssh_config_path: string;
};

type StoredPreparedSshTarget = PreparedSshTargetReference & {
  config_sha256: string;
  created_at: number;
  expires_at: number;
  config_directory: string;
  generated_identity_directory?: string;
};

const HOST_RE = /^[A-Za-z0-9_.:-]+$/;
const USER_RE = /^[A-Za-z0-9_.-]+$/;
const SENSITIVE_KEYS = /(?:password|passwd|pwd|passphrase|secret|token|private[_-]?key)$/iu;
const preparedSshTargets = new Map<string, StoredPreparedSshTarget[]>();
const DEFAULT_PREPARED_SSH_TTL_MS = 24 * 60 * 60 * 1_000;

function fail(message: string): never {
  throw new Error(message);
}

export function normalizeIpLiteral(value: string | undefined): string | undefined {
  const input = value?.trim() ?? "";
  if ((input.startsWith("[") || input.endsWith("]")) && !(input.startsWith("[") && input.endsWith("]"))) return undefined;
  const raw = input.startsWith("[") ? input.slice(1, -1) : input;
  const version = isIP(raw);
  if (version === 4) return raw.split(".").map((part) => String(Number(part))).join(".");
  if (version !== 6) return undefined;
  try {
    return new URL(`http://[${raw}]/`).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export function defaultSshConfigurationTargetsHost(host: string, invocationArgs: readonly string[] = []): boolean {
  const resolved = spawnSync("ssh", ["-G", ...invocationArgs, host], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3_000,
    windowsHide: true,
  });
  if (resolved.status !== 0) return false;
  return sshConfigurationIsSafeForHost(String(resolved.stdout), host);
}

export function sshConfigurationIsSafeForHost(output: string, host: string): boolean {
  const expected = normalizeIpLiteral(host);
  if (!expected) return false;
  const options = new Map<string, string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*([^\s]+)\s+(.+?)\s*$/u.exec(rawLine);
    if (match) options.set(match[1].toLowerCase(), match[2].toLowerCase());
  }
  const effective = normalizeIpLiteral(options.get("hostname"));
  const enabled = (name: string) => ["yes", "true"].includes(options.get(name) ?? "");
  const disabled = (name: string) => ["no", "off", "false"].includes(options.get(name) ?? "");
  const commandDisabled = (name: string) => ["", "none"].includes(options.get(name) ?? "");
  const knownHostFiles = [options.get("userknownhostsfile"), options.get("globalknownhostsfile")]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(/\s+/u));
  const hasKnownHostFile = knownHostFiles.some((value) => !["none", "nul", "/dev/null"].includes(value));
  return effective === expected
    && commandDisabled("proxycommand")
    && commandDisabled("localcommand")
    && commandDisabled("knownhostscommand")
    && !enabled("permitlocalcommand")
    && disabled("controlmaster")
    && commandDisabled("controlpath")
    && commandDisabled("proxyjump")
    && ["no", "off", "false", "0"].includes(options.get("controlpersist") ?? "0")
    && disabled("forwardagent")
    && !disabled("stricthostkeychecking")
    && hasKnownHostFile
    && enabled("batchmode")
    && disabled("passwordauthentication")
    && disabled("kbdinteractiveauthentication")
    && enabled("pubkeyauthentication");
}

export function canonicalProjectRootKey(projectRoot: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(projectRoot);
  } catch {
    resolved = path.resolve(projectRoot);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileSha256(filePath: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function preparedSshTtlMs(): number {
  const parsed = Number(process.env.VECTORMIND_PREPARED_SSH_TTL_SECONDS);
  return Number.isFinite(parsed) ? Math.max(60, Math.min(parsed, 7 * 24 * 60 * 60)) * 1_000 : DEFAULT_PREPARED_SSH_TTL_MS;
}

function removeOwnedTemporaryDirectory(directory: string | undefined, prefix: string): void {
  if (!directory) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith(prefix)) return;
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 1 }); } catch { /* Best effort only. */ }
}

function disposePreparedTarget(entry: StoredPreparedSshTarget): void {
  removeOwnedTemporaryDirectory(entry.config_directory, "vectormind-ssh-config-");
  removeOwnedTemporaryDirectory(entry.generated_identity_directory, "vectormind-ssh-");
}

function cleanupPreparedSshTargets(projectKey?: string): void {
  const keys = projectKey ? [projectKey] : [...preparedSshTargets.keys()];
  const now = Date.now();
  for (const key of keys) {
    const retained: StoredPreparedSshTarget[] = [];
    for (const entry of preparedSshTargets.get(key) ?? []) {
      if (entry.expires_at <= now || fileSha256(entry.ssh_config_path) !== entry.config_sha256) disposePreparedTarget(entry);
      else retained.push(entry);
    }
    preparedSshTargets.set(key, retained);
  }
}

const preparedSshCleanupTimer = setInterval(() => cleanupPreparedSshTargets(), 60_000);
preparedSshCleanupTimer.unref();

function registerPreparedSshTarget(
  projectRoot: string,
  host: string,
  configPath: string,
  configDirectory: string,
  generatedIdentityDirectory?: string,
): void {
  const digest = fileSha256(configPath);
  if (!digest) return;
  const key = canonicalProjectRootKey(projectRoot);
  cleanupPreparedSshTargets(key);
  const current = preparedSshTargets.get(key) ?? [];
  const next = current.filter((entry) => {
    if (entry.ssh_config_path !== configPath) return true;
    disposePreparedTarget(entry);
    return false;
  });
  const now = Date.now();
  next.push({
    alias: "vectormind-target", host, ssh_config_path: configPath, config_sha256: digest,
    created_at: now, expires_at: now + preparedSshTtlMs(), config_directory: configDirectory,
    ...(generatedIdentityDirectory ? { generated_identity_directory: generatedIdentityDirectory } : {}),
  });
  while (next.length > 20) disposePreparedTarget(next.shift()!);
  preparedSshTargets.set(key, next);
}

export function listPreparedSshTargets(projectRoot: string): PreparedSshTargetReference[] {
  const key = canonicalProjectRootKey(projectRoot);
  cleanupPreparedSshTargets(key);
  return (preparedSshTargets.get(key) ?? []).map(({ alias, host, ssh_config_path }) => ({ alias, host, ssh_config_path }));
}

process.once("exit", () => {
  clearInterval(preparedSshCleanupTimer);
  for (const entries of preparedSshTargets.values()) for (const entry of entries) disposePreparedTarget(entry);
  preparedSshTargets.clear();
});

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function parseSource(text: string): ParsedSshSource {
  const result: ParsedSshSource = { sensitiveFields: new Set<string>() };
  const positional: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=|:)\s*(.*?)\s*$/u.exec(line);
    if (!match) {
      positional.push(line);
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].replace(/^['"]|['"]$/gu, "").trim();
    if (SENSITIVE_KEYS.test(key)) {
      result.sensitiveFields.add(key);
      continue;
    }
    if (["host", "hostname", "server", "address", "ip"].includes(key)) result.host ??= value;
    else if (["user", "username", "login"].includes(key)) result.user ??= value;
    else if (key === "port") result.port ??= parsePort(value);
    else if (["identityfile", "identity_file", "key", "keyfile", "private_key_file"].includes(key)) result.identityFile ??= value;
  }
  if (!result.host && positional[0]) result.host = positional[0];
  if (!result.user && positional[1]) result.user = positional[1];
  if (positional[2]) result.sensitiveFields.add("password");
  return result;
}

function safeHost(value: string | undefined): string {
  const host = value?.trim() ?? "";
  if (!host || !HOST_RE.test(host) || host.includes("..")) fail("SSH host must be a plain hostname or IP address");
  return host;
}

function safeUser(value: string | undefined): string {
  const user = value?.trim() ?? "";
  if (!user || !USER_RE.test(user)) fail("SSH user is missing or invalid");
  return user;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function existingIdentity(candidate: string | undefined, baseDir: string): string | undefined {
  if (!candidate) return undefined;
  const expanded = expandHome(candidate);
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return undefined;
    // Private keys must not be group/world-readable on POSIX hosts.
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

function findExistingIdentity(source: ParsedSshSource, baseDir: string): string | undefined {
  const configured = existingIdentity(source.identityFile, baseDir);
  if (configured) return configured;
  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = existingIdentity(path.join(sshDir, name), baseDir);
    if (candidate) return candidate;
  }
  return undefined;
}

function generateIdentity(): { privateKey: string; publicKey: string; fingerprint?: string; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-ssh-"));
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the host. */ }
  const privateKey = path.join(directory, "id_ed25519");
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "vectormind-temporary", "-f", privateKey], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (generated.status !== 0 || !fs.existsSync(privateKey)) {
    removeOwnedTemporaryDirectory(directory, "vectormind-ssh-");
    fail("ssh-keygen is unavailable; configure an existing SSH identity instead");
  }
  const publicKeyPath = `${privateKey}.pub`;
  const publicKey = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, "utf8").trim() : "";
  if (!publicKey) {
    removeOwnedTemporaryDirectory(directory, "vectormind-ssh-");
    fail("ssh-keygen did not produce a public key");
  }
  try { fs.chmodSync(privateKey, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  let fingerprint: string | undefined;
  const listed = spawnSync("ssh-keygen", ["-lf", publicKeyPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  if (listed.status === 0) fingerprint = String(listed.stdout).trim().split(/\s+/u).slice(0, 2).join(" ");
  return { privateKey, publicKey, fingerprint, directory };
}

function sshConfigPathValue(filePath: string): string {
  // OpenSSH accepts quoted paths; forward slashes also avoid Windows escape ambiguity.
  return `"${filePath.replace(/\\/gu, "/").replace(/"/gu, '\\"')}"`;
}

function writeSecureConfig(target: { host: string; user: string; port: number }, identityFile: string): { configPath: string; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-ssh-config-"));
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the host. */ }
  const configPath = path.join(directory, "config");
  const config = [
    `Host vectormind-target ${target.host}`,
    `  HostName ${target.host}`,
    `  User ${target.user}`,
    `  Port ${target.port}`,
    `  IdentityFile ${sshConfigPathValue(identityFile)}`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  PreferredAuthentications publickey",
    "  StrictHostKeyChecking yes",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  return { configPath, directory };
}

export function readConfiguredSshTarget(options: {
  projectRoot: string;
  configPath?: string;
}): ConfiguredSshTarget | undefined {
  const root = path.resolve(options.projectRoot);
  const sourcePath = resolvePathWithinRoot(root, options.configPath ?? "server.txt", { allowMissing: true });
  try {
    if (fs.lstatSync(sourcePath).isSymbolicLink()) return undefined;
    if (!fs.statSync(sourcePath).isFile()) return undefined;
    const source = parseSource(fs.readFileSync(sourcePath, "utf8"));
    if (!source.host) return undefined;
    return { host: safeHost(source.host), port: source.port ?? 22 };
  } catch (error) {
    if (error instanceof Error && /SSH (?:source config|host)/u.test(error.message)) throw error;
    return undefined;
  }
}

export function readConfiguredDeploymentTarget(options: {
  projectRoot: string;
  configPath?: string;
}): ConfiguredSshTarget | undefined {
  const root = path.resolve(options.projectRoot);
  const sourcePath = resolvePathWithinRoot(root, options.configPath ?? "server.txt", { allowMissing: true });
  try {
    if (fs.lstatSync(sourcePath).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const target = readConfiguredSshTarget(options);
  const host = normalizeIpLiteral(target?.host);
  return target && host ? { host, port: target.port } : undefined;
}

/**
 * A host-injected IP is an explicit deployment target registration path. It
 * deliberately accepts IP literals only and does not read project files.
 */
export function readEnvironmentDeploymentTarget(): ConfiguredSshTarget | undefined {
  const host = normalizeIpLiteral(process.env.VECTORMIND_DEPLOYMENT_HOST);
  if (!host) return undefined;
  const port = parsePort(process.env.VECTORMIND_DEPLOYMENT_PORT) ?? 22;
  return { host, port };
}

export function prepareSecureSsh(options: {
  projectRoot: string;
  configPath?: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  generateKey?: boolean;
}): SecureSshPreparation {
  const root = path.resolve(options.projectRoot);
  const sourcePath = resolvePathWithinRoot(root, options.configPath ?? "server.txt", { allowMissing: true });
  let source: ParsedSshSource = { sensitiveFields: new Set<string>() };
  try {
    if (fs.lstatSync(sourcePath).isSymbolicLink()) fail("SSH source config must not be a symbolic link");
    if (fs.statSync(sourcePath).isFile()) source = parseSource(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && /SSH source config/u.test(error.message)) throw error;
    // A source file is optional when host/user are supplied explicitly.
  }
  const target = {
    host: safeHost(options.host ?? source.host),
    user: safeUser(options.user ?? source.user),
    port: options.port ?? source.port ?? 22,
  };
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) fail("SSH port must be between 1 and 65535");
  const explicitIdentity = existingIdentity(options.identityFile, root);
  const identity = explicitIdentity ?? (options.identityFile ? undefined : findExistingIdentity(source, path.dirname(sourcePath)));
  let identityFile = identity;
  let generatedKey = false;
  let generatedIdentityDirectory: string | undefined;
  let publicKey: string | undefined;
  let fingerprint: string | undefined;
  if (!identityFile) {
    if (options.generateKey === false) fail("No existing SSH identity found and generate_key=false");
    const generated = generateIdentity();
    identityFile = generated.privateKey;
    publicKey = generated.publicKey;
    fingerprint = generated.fingerprint;
    generatedIdentityDirectory = generated.directory;
    generatedKey = true;
  }
  let secureConfig: { configPath: string; directory: string };
  try {
    secureConfig = writeSecureConfig(target, identityFile);
  } catch (error) {
    removeOwnedTemporaryDirectory(generatedIdentityDirectory, "vectormind-ssh-");
    throw error;
  }
  registerPreparedSshTarget(root, target.host, secureConfig.configPath, secureConfig.directory, generatedIdentityDirectory);
  return {
    ok: true,
    status: generatedKey ? "key_installation_required" : "ready",
    target,
    ssh_config_path: secureConfig.configPath,
    identity_file: identityFile,
    ...(publicKey ? { public_key: publicKey } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    generated_key: generatedKey,
    password_authentication_disabled: true,
    sensitive_fields_detected: [...source.sensitiveFields].sort(),
    note: generatedKey
      ? "A temporary key was generated on the host. Install its public_key on the target before deployment; password authentication was not attempted."
      : "An existing host-side SSH identity is selected. Password authentication was disabled.",
  };
}
