#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";

const RTK_REPO = "rtk-ai/rtk";
const RTK_DOWNLOAD_BASE = `https://github.com/${RTK_REPO}/releases/latest/download`;
const SELF_PATH = process.argv[1] ? path.resolve(process.argv[1]) : "";
const exeName = process.platform === "win32" ? "rtk.exe" : "rtk";
const cacheRoot =
  process.env.VECTORMIND_RTK_HOME ??
  path.join(os.homedir(), ".cache", "vector-mind", "rtk");
const cacheBinDir = path.join(cacheRoot, "bin");
const cachedRtkPath = path.join(cacheBinDir, exeName);

function pathEquals(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
  } catch {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function findRealRtkOnPath(): string | null {
  const explicit = process.env.VECTORMIND_RTK_REAL;
  if (explicit && isExecutableFile(explicit)) return explicit;
  if (isExecutableFile(cachedRtkPath)) return cachedRtkPath;

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates =
    process.platform === "win32"
      ? ["rtk.exe", "rtk.cmd", "rtk.bat"]
      : ["rtk"];

  for (const dir of pathEntries) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      if (SELF_PATH && pathEquals(candidate, SELF_PATH)) continue;
      // npm creates .cmd/.bat launchers for this shim on Windows; avoid
      // recursing into ourselves when those wrappers are first on PATH.
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function platformAsset(): { archiveName: string; binaryName: string } {
  const arch = os.arch();
  if (process.platform === "win32" && arch === "x64") {
    return { archiveName: "rtk-x86_64-pc-windows-msvc.zip", binaryName: "rtk.exe" };
  }
  if (process.platform === "darwin" && arch === "arm64") {
    return { archiveName: "rtk-aarch64-apple-darwin.tar.gz", binaryName: "rtk" };
  }
  if (process.platform === "darwin" && arch === "x64") {
    return { archiveName: "rtk-x86_64-apple-darwin.tar.gz", binaryName: "rtk" };
  }
  if (process.platform === "linux" && arch === "arm64") {
    return { archiveName: "rtk-aarch64-unknown-linux-gnu.tar.gz", binaryName: "rtk" };
  }
  if (process.platform === "linux" && arch === "x64") {
    return { archiveName: "rtk-x86_64-unknown-linux-musl.tar.gz", binaryName: "rtk" };
  }
  throw new Error(`Unsupported platform for RTK auto-install: ${process.platform}/${arch}`);
}

function run(command: string, args: string[], opts: { cwd?: string; inherit?: boolean } = {}) {
  return spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
}

function download(url: string, destination: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "vector-mind-rtk-shim",
          Accept: "application/octet-stream",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 8) {
          response.resume();
          const next = new URL(location, url).toString();
          void download(next, destination, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`Download failed ${status}: ${url}`));
          return;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const file = fs.createWriteStream(destination);
        response.pipe(file);
        file.on("finish", () => {
          file.close((err) => (err ? reject(err) : resolve()));
        });
        file.on("error", reject);
      },
    );
    request.on("error", reject);
    request.setTimeout(120_000, () => {
      request.destroy(new Error("Download timed out"));
    });
  });
}

function findFileRecursive(root: string, fileName: string): string | null {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name === fileName) return full;
    }
  }
  return null;
}

function extractArchive(archivePath: string, extractDir: string): void {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const result = run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ]);
      if (result.status !== 0) {
        throw new Error(`Expand-Archive failed: ${result.stderr || result.stdout}`);
      }
      return;
    }
    const unzip = run("unzip", ["-o", archivePath, "-d", extractDir]);
    if (unzip.status === 0) return;
    const tar = run("tar", ["-xf", archivePath, "-C", extractDir]);
    if (tar.status === 0) return;
    throw new Error(`Could not extract zip: ${unzip.stderr || tar.stderr || unzip.stdout || tar.stdout}`);
  }

  const result = run("tar", ["-xzf", archivePath, "-C", extractDir]);
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${result.stderr || result.stdout}`);
  }
}

async function installFromRelease(): Promise<string> {
  const asset = platformAsset();
  const archivePath = path.join(cacheRoot, "downloads", asset.archiveName);
  const extractDir = path.join(cacheRoot, "extract", asset.archiveName.replace(/[^\w.-]+/g, "_"));
  const url = `${RTK_DOWNLOAD_BASE}/${asset.archiveName}`;

  console.error(`[vector-mind] RTK not found; downloading ${url}`);
  await download(url, archivePath);
  extractArchive(archivePath, extractDir);

  const extracted = findFileRecursive(extractDir, asset.binaryName);
  if (!extracted) throw new Error(`Downloaded RTK archive did not contain ${asset.binaryName}`);

  fs.mkdirSync(cacheBinDir, { recursive: true });
  fs.copyFileSync(extracted, cachedRtkPath);
  try {
    fs.chmodSync(cachedRtkPath, 0o755);
  } catch {
    // Windows may ignore chmod.
  }
  return cachedRtkPath;
}

function installFromCargo(): string {
  const cargo = run("cargo", ["--version"]);
  if (cargo.status !== 0) {
    throw new Error(
      "RTK auto-install failed and Cargo is unavailable. Install Rust/Cargo or set VECTORMIND_RTK_REAL to an existing rtk binary.",
    );
  }
  const cargoRoot = path.join(cacheRoot, "cargo");
  console.error(`[vector-mind] Falling back to Cargo install for ${RTK_REPO}...`);
  const result = run(
    "cargo",
    ["install", "--git", `https://github.com/${RTK_REPO}`, "--root", cargoRoot],
    { inherit: true },
  );
  if (result.status !== 0) throw new Error(`cargo install failed with status ${result.status}`);
  const installed = path.join(cargoRoot, "bin", exeName);
  if (!isExecutableFile(installed)) throw new Error(`cargo install completed but ${installed} was not found`);
  fs.mkdirSync(cacheBinDir, { recursive: true });
  fs.copyFileSync(installed, cachedRtkPath);
  try {
    fs.chmodSync(cachedRtkPath, 0o755);
  } catch {}
  return cachedRtkPath;
}

async function ensureRtk(): Promise<string> {
  const existing = findRealRtkOnPath();
  if (existing) return existing;
  if (process.env.VECTORMIND_RTK_NO_AUTO_INSTALL === "1") {
    throw new Error("RTK is missing and VECTORMIND_RTK_NO_AUTO_INSTALL=1 is set.");
  }
  try {
    return await installFromRelease();
  } catch (err) {
    console.error(`[vector-mind] RTK release install failed: ${String(err)}`);
    return installFromCargo();
  }
}

async function main(): Promise<void> {
  const realRtk = await ensureRtk();
  const args = process.argv.slice(2);
  const result = spawnSync(realRtk, args, {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      VECTORMIND_RTK_REAL: realRtk,
    },
  });
  if (result.error) {
    console.error(`[vector-mind] Failed to run RTK: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

main().catch((err) => {
  console.error(`[vector-mind] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
