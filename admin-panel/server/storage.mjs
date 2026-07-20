import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function projectPathIdentity(projectPath, platform = process.platform) {
  const raw = String(projectPath ?? "").trim();
  if (!raw) return "";
  const resolved = path.resolve(raw);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function atomicWriteTextFile(filePath, content, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd = null;
  fsImpl.mkdirSync(directory, { recursive: true });
  try {
    fd = fsImpl.openSync(tempPath, "wx", 0o600);
    fsImpl.writeFileSync(fd, content, "utf8");
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tempPath, filePath);
    try {
      const directoryFd = fsImpl.openSync(directory, "r");
      try {
        fsImpl.fsyncSync(directoryFd);
      } finally {
        fsImpl.closeSync(directoryFd);
      }
    } catch {
      // Directory fsync is not available on every platform/filesystem.
    }
  } catch (err) {
    if (fd != null) {
      try {
        fsImpl.closeSync(fd);
      } catch {}
    }
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {}
    throw err;
  }
}
