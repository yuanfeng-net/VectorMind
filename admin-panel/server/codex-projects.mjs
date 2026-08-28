import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectPathIdentity } from "./storage.mjs";

const MAX_CODEX_STATE_BYTES = 10 * 1024 * 1024;

export function codexGlobalStatePath({ env = process.env, homeDir = os.homedir() } = {}) {
  const codexHome = String(env.CODEX_HOME ?? "").trim();
  return path.join(codexHome ? path.resolve(codexHome) : path.join(homeDir, ".codex"), ".codex-global-state.json");
}

function realDirectory(directory, fsImpl) {
  if (typeof directory !== "string" || !directory.trim() || !path.isAbsolute(directory)) return null;
  try {
    if (!fsImpl.statSync(directory).isDirectory()) return null;
    return fsImpl.realpathSync.native(directory);
  } catch {
    return null;
  }
}

export function readCodexLocalProjects({ env = process.env, homeDir = os.homedir(), fsImpl = fs } = {}) {
  const statePath = codexGlobalStatePath({ env, homeDir });
  try {
    const stat = fsImpl.statSync(statePath);
    if (!stat.isFile() || stat.size > MAX_CODEX_STATE_BYTES) {
      return { available: true, statePath, projects: [], skipped: 0, error: "Codex project state is not a bounded file." };
    }
    const state = JSON.parse(fsImpl.readFileSync(statePath, "utf8"));
    const localProjects = state?.["local-projects"];
    if (!localProjects || typeof localProjects !== "object" || Array.isArray(localProjects)) {
      return { available: true, statePath, projects: [], skipped: 0, error: null };
    }
    const order = Array.isArray(state?.["project-order"])
      ? state["project-order"].filter((id) => typeof id === "string")
      : [];
    const rank = new Map(order.map((id, index) => [id, index]));
    const seen = new Set();
    const projects = [];
    let skipped = 0;
    const records = Object.entries(localProjects)
      .sort(([left], [right]) => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER));
    for (const [sourceProjectId, value] of records) {
      if (!value || typeof value !== "object") { skipped += 1; continue; }
      const rootPaths = Array.isArray(value.rootPaths) ? value.rootPaths : [];
      for (const rootPath of rootPaths) {
        const projectPath = realDirectory(rootPath, fsImpl);
        if (!projectPath) { skipped += 1; continue; }
        const identity = projectPathIdentity(projectPath);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const sourceName = String(value.name ?? "").trim();
        projects.push({
          sourceProjectId,
          sourceName: rootPaths.length > 1 && sourceName
            ? `${sourceName} - ${path.basename(projectPath)}`
            : sourceName || path.basename(projectPath) || projectPath,
          path: projectPath,
          sourceUpdatedAt: Number.isFinite(Number(value.updatedAt))
            ? new Date(Number(value.updatedAt)).toISOString()
            : null,
        });
      }
    }
    return { available: true, statePath, projects, skipped, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, statePath, projects: [], skipped: 0, error: null };
    return { available: true, statePath, projects: [], skipped: 0, error: error?.message ?? String(error) };
  }
}

function codexProjectRecord(project, now) {
  const id = `prj_${crypto.createHash("sha1").update(projectPathIdentity(project.path)).digest("hex").slice(0, 12)}`;
  return {
    id,
    name: project.sourceName,
    folderName: path.basename(project.path) || project.path,
    path: project.path,
    source: "codex",
    sourceProjectId: project.sourceProjectId,
    sourceUpdatedAt: project.sourceUpdatedAt,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: null,
  };
}

export function syncCodexProjectRecords(existingProjects, discoveredProjects, now = new Date().toISOString()) {
  const existing = Array.isArray(existingProjects) ? existingProjects : [];
  const byPath = new Map(existing.map((project) => [projectPathIdentity(project.path), project]));
  const matched = new Set();
  const projects = [];
  let added = 0;
  let updated = 0;
  for (const discovered of discoveredProjects) {
    const identity = projectPathIdentity(discovered.path);
    const current = byPath.get(identity);
    matched.add(identity);
    if (!current) {
      projects.push(codexProjectRecord(discovered, now));
      added += 1;
      continue;
    }
    if (current.source !== "codex") {
      projects.push(current);
      continue;
    }
    const next = {
      ...current,
      name: discovered.sourceName,
      folderName: path.basename(discovered.path) || discovered.path,
      path: discovered.path,
      sourceProjectId: discovered.sourceProjectId,
      sourceUpdatedAt: discovered.sourceUpdatedAt,
    };
    const changed = ["name", "folderName", "path", "sourceProjectId", "sourceUpdatedAt"]
      .some((key) => current[key] !== next[key]);
    projects.push(changed ? { ...next, updatedAt: now } : current);
    if (changed) updated += 1;
  }
  let removed = 0;
  for (const project of existing) {
    const identity = projectPathIdentity(project.path);
    if (matched.has(identity)) continue;
    if (project.source === "codex") { removed += 1; continue; }
    projects.push(project);
  }
  return { projects, changed: added > 0 || updated > 0 || removed > 0, added, updated, removed };
}
