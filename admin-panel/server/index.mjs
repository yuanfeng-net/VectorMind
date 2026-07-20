#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import Database from "better-sqlite3";

import { ADMIN_TOKEN_HEADER, createAdminSecurityPolicy, evaluateAdminRequest } from "./security.mjs";
import { atomicWriteTextFile, projectPathIdentity } from "./storage.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CLIENT_DIR = path.join(ROOT_DIR, "client");
const DIST_DIR = path.join(ROOT_DIR, "dist", "client");

const PORT = Number.parseInt(process.env.VECTORMIND_ADMIN_PORT ?? "16860", 10) || 16860;
const HOST = process.env.VECTORMIND_ADMIN_HOST?.trim() || "127.0.0.1";
const ADMIN_SECURITY = createAdminSecurityPolicy({
  host: HOST,
  port: PORT,
  configuredToken: process.env.VECTORMIND_ADMIN_TOKEN,
});
const ADMIN_TOKEN = ADMIN_SECURITY.token;
const STORAGE_DIR = path.join(os.homedir(), ".vectormind-admin");
const INDEX_FILE = path.join(STORAGE_DIR, "projects.json");
const CURRENT_PROJECT_ROOT = path.resolve(ROOT_DIR, "..");

const SKIP_SCAN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".codex",
  ".vscode",
  ".vs",
  ".vectormind",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  "AppData",
]);

function ensureStorage() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    writeIndex({
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projects: [],
    });
  }
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readIndex() {
  ensureStorage();
  const fallback = {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projects: [],
  };
  const parsed = safeJsonParse(fs.readFileSync(INDEX_FILE, "utf8"), fallback);
  return {
    version: 1,
    createdAt: parsed.createdAt ?? fallback.createdAt,
    updatedAt: parsed.updatedAt ?? fallback.updatedAt,
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
}

function writeIndex(index) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const normalized = {
    version: 1,
    createdAt: index.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projects: Array.isArray(index.projects) ? index.projects : [],
  };
  atomicWriteTextFile(INDEX_FILE, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function expandPath(input) {
  const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return "";
  const withEnv = raw.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? `%${key}%`);
  if (withEnv === "~") return os.homedir();
  if (withEnv.startsWith(`~${path.sep}`) || withEnv.startsWith("~/") || withEnv.startsWith("~\\")) {
    return path.join(os.homedir(), withEnv.slice(2));
  }
  return withEnv;
}

function normalizeProjectPath(input) {
  const expanded = expandPath(input);
  if (!expanded) return "";
  return path.resolve(expanded);
}

function realDirectoryPath(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) {
    const error = new Error("请输入项目路径。");
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(normalized)) {
    const error = new Error(`项目路径不存在：${normalized}`);
    error.status = 400;
    throw error;
  }
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    const error = new Error(`项目路径不是文件夹：${normalized}`);
    error.status = 400;
    throw error;
  }
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

function projectIdFor(projectPath) {
  return `prj_${crypto.createHash("sha1").update(projectPathIdentity(projectPath)).digest("hex").slice(0, 12)}`;
}

function folderNameFor(projectPath) {
  return path.basename(projectPath) || projectPath;
}

function toProjectRecord(input, previous = null) {
  const realPath = realDirectoryPath(input.path);
  const now = new Date().toISOString();
  return {
    id: previous?.id ?? projectIdFor(realPath),
    name: String(input.name ?? previous?.name ?? folderNameFor(realPath)).trim() || folderNameFor(realPath),
    folderName: folderNameFor(realPath),
    path: realPath,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastOpenedAt: previous?.lastOpenedAt ?? null,
  };
}

function upsertProject(input) {
  const index = readIndex();
  const candidatePath = realDirectoryPath(input.path);
  const id = input.id ?? projectIdFor(candidatePath);
  const existingIndex = index.projects.findIndex(
    (p) => p.id === id || projectPathIdentity(String(p.path ?? "")) === projectPathIdentity(candidatePath),
  );
  const previous = existingIndex >= 0 ? index.projects[existingIndex] : { id };
  const record = toProjectRecord({ ...input, path: candidatePath }, previous);
  if (existingIndex >= 0) index.projects[existingIndex] = record;
  else index.projects.unshift(record);
  writeIndex(index);
  return record;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      sizeText: formatBytes(stat.size),
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false, size: 0, sizeText: "0 B", modifiedAt: null };
  }
}

function tableExists(db, tableName) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1")
    .get(tableName);
}

function columnExists(db, tableName, columnName) {
  if (!tableExists(db, tableName)) return false;
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function safeGet(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return undefined;
  }
}

function safeCount(db, tableName, where = "", params = []) {
  if (!tableExists(db, tableName)) return 0;
  const row = safeGet(db, `SELECT COUNT(*) AS count FROM ${tableName} ${where}`, params);
  return Number(row?.count ?? 0);
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function previewText(text, max = 180) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function hasCorruptQuestionRuns(text) {
  return /[?？]{3,}/.test(String(text ?? ""));
}

function isMostlyCorruptText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (!hasCorruptQuestionRuns(raw)) return false;
  const compact = raw.replace(/\s+/g, "");
  const questionCount = (compact.match(/[?？]/g) ?? []).length;
  return questionCount / Math.max(1, compact.length) > 0.22;
}

function semanticFallbackForCorruptText(text, fallback = "未识别记忆") {
  const raw = String(text ?? "");
  const parts = [];
  if (/memory maintenance/i.test(raw)) parts.push("记忆维护");
  if (/WAL\s+checkpoint/i.test(raw)) parts.push("WAL checkpoint");
  if (/dry-run/i.test(raw)) parts.push("dry-run");
  if (/checkpoint/i.test(raw) && !parts.some((part) => /checkpoint/i.test(part))) parts.push("checkpoint");
  if (parts.length) return parts.join(" / ");
  return fallback;
}

function cleanDisplayText(text, fallback = "未识别记忆", max = 180) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  if (isMostlyCorruptText(raw)) return previewText(semanticFallbackForCorruptText(raw, fallback), max);
  const cleaned = raw
    .replace(/[?？]{3,}/g, "…")
    .replace(/\s+/g, " ")
    .replace(/(?:…\s*){2,}/g, "…")
    .trim();
  if (!cleaned || cleaned === "…") return fallback;
  return previewText(cleaned, max);
}

function normalizeForGrouping(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/[?？]{3,}/g, "?")
    .trim();
}

function groupChangeLogRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const rowFiles = parseChangeLogFiles(row);
    const intentKey = normalizeForGrouping(row.intent_summary);
    let aggregateFiles = null;
    try {
      aggregateFiles = row.files_json ? JSON.parse(row.files_json) : null;
    } catch {
      aggregateFiles = null;
    }
    const key = Array.isArray(aggregateFiles)
      ? `aggregate:${row.id}`
      : `${row.req_id ?? ""}|${row.timestamp ?? ""}|${intentKey}`;
    const existing =
      groups.get(key) ??
      {
        id: row.id,
        ids: [],
        req_id: row.req_id,
        intent_summary: row.intent_summary,
        timestamp: row.timestamp,
        files: [],
      };
    existing.ids.push(row.id);
    for (const filePath of rowFiles) {
      if (filePath && !existing.files.includes(filePath)) existing.files.push(filePath);
    }
    groups.set(key, existing);
  }
  return [...groups.values()];
}

function parseChangeLogFiles(row) {
  if (row?.files_json) {
    try {
      const parsed = JSON.parse(row.files_json);
      if (Array.isArray(parsed)) {
        const files = parsed
          .map((item) => (item && typeof item === "object" ? item.file_path : null))
          .filter((filePath) => typeof filePath === "string" && filePath && filePath !== "(multiple)");
        if (files.length) return files;
      }
    } catch {
      // fall back to file_path
    }
  }
  return row?.file_path && row.file_path !== "(multiple)" ? [row.file_path] : [];
}

function summarizeFiles(files) {
  const unique = [...new Set((files ?? []).filter(Boolean))];
  if (!unique.length) return "";
  if (unique.length === 1) return unique[0];
  const shown = unique.slice(0, 4).join("、");
  const suffix = unique.length > 4 ? " 等" : "";
  return `涉及 ${unique.length} 个文件：${shown}${suffix}`;
}

function memoryItemFiles(row) {
  const metadata = parseMaybeJson(row?.metadata_json) ?? {};
  if (!Array.isArray(metadata.files)) return [];
  return metadata.files
    .map((item) => (item && typeof item === "object" ? item.file_path : null))
    .filter((filePath) => typeof filePath === "string" && filePath && filePath !== "(multiple)" && filePath !== "(unspecified)");
}

function memoryLogTitle(row) {
  if (row.kind === "change_intent") return cleanDisplayText(row.content, "记录改动意图", 132);
  if (row.kind === "requirement") return cleanDisplayText(row.title, "需求记录", 120);
  return cleanDisplayText(row.title || mapMemoryKind(row.kind), mapMemoryKind(row.kind), 120);
}

function memoryLogDetail(row) {
  if (row.kind === "change_intent") {
    const files = memoryItemFiles(row);
    const filesText = summarizeFiles(files);
    if (filesText) return filesText;
    return cleanDisplayText(row.title, "所属需求", 160);
  }
  return cleanDisplayText(row.content, "暂无可读记忆内容", 160);
}

function numericSetValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function buildMemoryLogMirrorKeys(memoryRows) {
  const requirementReqIds = new Set();
  const changeLogIds = new Set();
  const changeIntentKeys = new Set();

  for (const row of memoryRows) {
    const reqId = numericSetValue(row.req_id);
    if (row.kind === "requirement" && reqId !== null) {
      requirementReqIds.add(reqId);
      continue;
    }

    if (row.kind !== "change_intent") continue;
    if (reqId !== null) {
      changeIntentKeys.add(`${reqId}|${normalizeForGrouping(row.content)}`);
    }

    const metadata = parseMaybeJson(row.metadata_json) ?? {};
    const changeLogId = numericSetValue(metadata.change_log_id);
    if (changeLogId !== null) changeLogIds.add(changeLogId);
    if (Array.isArray(metadata.source_change_ids)) {
      for (const id of metadata.source_change_ids) {
        const parsed = numericSetValue(id);
        if (parsed !== null) changeLogIds.add(parsed);
      }
    }
  }

  return { requirementReqIds, changeLogIds, changeIntentKeys };
}

function mapMemoryKind(kind) {
  const labels = {
    project_summary: "项目摘要",
    requirement: "需求",
    change_intent: "改动意图",
    note: "备注",
    decision: "决策",
    convention: "规则",
    checkpoint: "检查点",
    memory_compaction: "压缩",
    file_chunk: "代码块",
    fix_pattern: "修复模式",
  };
  return labels[kind] ?? kind ?? "记忆";
}

function memoryLevelFor(kind) {
  if (["decision", "convention", "project_summary", "requirement"].includes(kind)) return "hit";
  if (["fix_pattern", "memory_compaction", "checkpoint"].includes(kind)) return "warn";
  if (["file_chunk"].includes(kind)) return "muted";
  return "info";
}

function guardLevelForSeverity(severity) {
  if (severity === "critical" || severity === "warn") return "warn";
  if (severity === "ok") return "hit";
  return "info";
}

function kindLabelForGuard(kind) {
  const labels = {
    fix_pattern: "回归防护",
    memory_compaction: "记忆维护",
    checkpoint: "上下文检查点",
  };
  return labels[kind] ?? mapMemoryKind(kind);
}

function categoryForGuardEventType(eventType) {
  if (String(eventType).includes("large_file")) return "大文件";
  if (String(eventType).includes("scope")) return "需求边界";
  if (String(eventType).includes("requirement")) return "需求映射";
  if (String(eventType).includes("cross_project")) return "项目隔离";
  if (String(eventType).includes("operation")) return "操作防护";
  if (String(eventType).includes("warning")) return "开发防护";
  return "MCP 防护";
}

function statusForGuardSeverity(severity) {
  if (severity === "critical") return "已拦截";
  if (severity === "warn") return "已提醒";
  return "已辅助";
}

function buildMcpGuardLogs({ guardRows = [] }) {
  const logs = [];
  for (const row of guardRows.slice(0, 50)) {
    logs.push({
      id: `guard-event-${row.id}`,
      at: row.created_at,
      title: cleanDisplayText(row.title, "MCP 防护事件", 140),
      detail: cleanDisplayText(row.detail, row.tool_name ? `工具：${row.tool_name}` : "MCP 已介入", 200),
      status: statusForGuardSeverity(row.severity),
      level: guardLevelForSeverity(row.severity),
      category: categoryForGuardEventType(row.event_type),
    });
  }

  const deduped = new Map();
  for (const log of logs) {
    const key = `${log.id}`;
    if (!deduped.has(key)) deduped.set(key, log);
  }
  return [...deduped.values()]
    .filter((row) => row.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 36);
}

function withDb(project, readFn) {
  const dbPath = path.join(project.path, ".vectormind", "vectormind.db");
  if (!fs.existsSync(dbPath)) return readFn(null, dbPath);
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    return readFn(db, dbPath);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function readProjectMemory(project) {
  const dbPath = path.join(project.path, ".vectormind", "vectormind.db");
  const dbMain = fileInfo(dbPath);
  const wal = fileInfo(`${dbPath}-wal`);
  const shm = fileInfo(`${dbPath}-shm`);
  const totalBytes = dbMain.size + wal.size + shm.size;

  const base = {
    dbPresent: dbMain.exists,
    dbPath,
    dbSize: totalBytes,
    dbSizeText: formatBytes(totalBytes),
    dbModifiedAt: dbMain.modifiedAt,
    counts: {
      requirements: 0,
      activeRequirements: 0,
      completedRequirements: 0,
      memoryItems: 0,
      pendingChanges: 0,
      changeLogs: 0,
      symbols: 0,
      decisions: 0,
      conventions: 0,
      notes: 0,
      checkpoints: 0,
    },
    kindCounts: [],
    appliedMemory: [],
    commandLogs: [],
    memoryLogs: [],
    health: {
      hitRate: 0,
      conflictCount: 0,
      lastAppliedAt: null,
      watcherHint: "读取本地 SQLite 记忆库",
    },
  };

  let auditForGuardLogs = null;
  try {
    auditForGuardLogs = readMemoryAudit(project);
  } catch {
    auditForGuardLogs = null;
  }

  return withDb(project, (db) => {
    if (!db) return base;

    const counts = {
      requirements: safeCount(db, "requirements"),
      activeRequirements: safeCount(db, "requirements", "WHERE status = 'active'"),
      completedRequirements: safeCount(db, "requirements", "WHERE status = 'completed'"),
      memoryItems: safeCount(db, "memory_items"),
      pendingChanges: safeCount(db, "pending_changes"),
      changeLogs: safeCount(db, "change_logs"),
      symbols: safeCount(db, "symbols"),
      decisions: safeCount(db, "memory_items", "WHERE kind = 'decision'"),
      conventions: safeCount(db, "memory_items", "WHERE kind = 'convention'"),
      notes: safeCount(db, "memory_items", "WHERE kind = 'note'"),
      checkpoints: safeCount(db, "memory_items", "WHERE kind = 'checkpoint'"),
    };

    const kindCounts = safeAll(
      db,
      `SELECT kind, COUNT(*) AS count
       FROM memory_items
       GROUP BY kind
       ORDER BY count DESC, kind ASC`,
    ).map((row) => ({
      kind: row.kind,
      label: mapMemoryKind(row.kind),
      count: Number(row.count ?? 0),
    }));

    const memoryRows = safeAll(
      db,
      `SELECT id, kind, title, content, file_path, start_line, end_line, req_id, metadata_json, created_at, updated_at
       FROM memory_items
       WHERE kind IN ('project_summary','requirement','change_intent','note','decision','convention','checkpoint','memory_compaction','fix_pattern')
       ORDER BY updated_at DESC, id DESC
       LIMIT 120`,
    );

    const activeRequirements = safeAll(
      db,
      `SELECT id, title, status, context_data, created_at, updated_at
       FROM requirements
       WHERE status = 'active'
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 12`,
    );

    const recentRequirements = safeAll(
      db,
      `SELECT id, title, status, context_data, created_at, updated_at
       FROM requirements
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 20`,
    );

    const hasAggregateChangeColumns =
      columnExists(db, "change_logs", "files_json") && columnExists(db, "change_logs", "file_count");
    const changeRows = hasAggregateChangeColumns
      ? safeAll(
          db,
          `SELECT id, req_id, file_path, intent_summary, files_json, file_count, timestamp
           FROM change_logs
           ORDER BY timestamp DESC, id DESC
           LIMIT 40`,
        )
      : safeAll(
          db,
          `SELECT id, req_id, file_path, intent_summary, NULL AS files_json, 1 AS file_count, timestamp
           FROM change_logs
           ORDER BY timestamp DESC, id DESC
           LIMIT 40`,
        );

    const pendingRows = safeAll(
      db,
      `SELECT file_path, last_event, updated_at
       FROM pending_changes
       ORDER BY updated_at DESC
       LIMIT 20`,
    );
    const groupedChangeRows = groupChangeLogRows(changeRows);
    const guardRows = safeAll(
      db,
      `SELECT id, tool_name, event_type, severity, title, detail, metadata_json, created_at
       FROM mcp_guard_events
       ORDER BY created_at DESC, id DESC
       LIMIT 80`,
    );

    const appliedMemory = [
      ...activeRequirements.map((row) => ({
        id: `req-${row.id}`,
        kind: "requirement",
        label: "活跃需求",
        title: cleanDisplayText(row.title, "未命名活跃需求", 96),
        preview: cleanDisplayText(row.context_data || row.title, "暂无可读需求上下文", 220),
        updatedAt: row.updated_at ?? row.created_at,
        level: "hit",
      })),
      ...memoryRows
        .filter((row) => ["project_summary", "decision", "convention", "note", "fix_pattern"].includes(row.kind))
        .slice(0, 18)
        .map((row) => ({
          id: `mem-${row.id}`,
          kind: row.kind,
          label: mapMemoryKind(row.kind),
          title: cleanDisplayText(row.title || mapMemoryKind(row.kind), mapMemoryKind(row.kind), 96),
          preview: cleanDisplayText(row.content, "暂无可读记忆内容", 180),
          filePath: row.file_path,
          updatedAt: row.updated_at,
          metadata: parseMaybeJson(row.metadata_json),
          level: memoryLevelFor(row.kind),
        })),
    ].slice(0, 24);

    const commandLogs = buildMcpGuardLogs({
      guardRows,
      audit: auditForGuardLogs,
      pendingRows,
      activeRequirements,
      memoryRows,
      dbModifiedAt: dbMain.modifiedAt,
    });
    const memoryMirrorKeys = buildMemoryLogMirrorKeys(memoryRows);
    const changeRowsForMemoryLogs = groupedChangeRows.filter((row) => {
      if (memoryMirrorKeys.changeLogIds.has(Number(row.id))) return false;
      const reqId = numericSetValue(row.req_id);
      if (reqId !== null) {
        const key = `${reqId}|${normalizeForGrouping(row.intent_summary)}`;
        if (memoryMirrorKeys.changeIntentKeys.has(key)) return false;
      }
      return true;
    });
    const requirementRowsForMemoryLogs = recentRequirements.filter((row) => {
      const reqId = numericSetValue(row.id);
      return reqId === null || !memoryMirrorKeys.requirementReqIds.has(reqId);
    });

    const memoryLogs = [
      ...memoryRows.map((row) => ({
        id: `memlog-${row.id}`,
        at: row.updated_at ?? row.created_at,
        title: memoryLogTitle(row),
        detail: memoryLogDetail(row),
        status: mapMemoryKind(row.kind),
        level: memoryLevelFor(row.kind),
        category: row.kind,
      })),
      ...changeRowsForMemoryLogs.map((row) => ({
        id: `change-${row.id}`,
        at: row.timestamp,
        title: cleanDisplayText(row.intent_summary, "记录改动意图", 120),
        detail: summarizeFiles(row.files),
        status: "改动意图",
        level: "info",
        category: "change_intent",
      })),
      ...requirementRowsForMemoryLogs.map((row) => ({
        id: `requirement-${row.id}`,
        at: row.updated_at ?? row.created_at,
        title: cleanDisplayText(row.title, row.status === "active" ? "活跃需求" : "历史需求", 120),
        detail: row.status === "active" ? "当前活跃需求" : "历史需求",
        status: row.status === "active" ? "需求" : "历史",
        level: row.status === "active" ? "hit" : "muted",
        category: "requirement",
      })),
    ]
      .filter((row) => row.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 80);

    const hitBase = counts.decisions + counts.conventions + counts.activeRequirements;
    const denominator = Math.max(1, hitBase + counts.pendingChanges);
    const hitRate = Math.max(0, Math.min(100, (hitBase / denominator) * 100));

    return {
      ...base,
      counts,
      kindCounts,
      appliedMemory,
      commandLogs,
      memoryLogs,
      health: {
        hitRate: Number(hitRate.toFixed(1)),
        conflictCount: 0,
        lastAppliedAt: memoryLogs[0]?.at ?? commandLogs[0]?.at ?? dbMain.modifiedAt,
        watcherHint: "读取本地 SQLite 记忆库",
      },
    };
  });
}

function summarizeProject(project) {
  const memory = readProjectMemory(project);
  return {
    ...project,
    exists: fs.existsSync(project.path),
    memory: {
      dbPresent: memory.dbPresent,
      dbPath: memory.dbPath,
      dbSizeText: memory.dbSizeText,
      dbModifiedAt: memory.dbModifiedAt,
      counts: memory.counts,
      health: memory.health,
    },
  };
}

function addCurrentProjectIfEmpty() {
  const index = readIndex();
  if (index.projects.length > 0) return;
  if (fs.existsSync(path.join(CURRENT_PROJECT_ROOT, ".vectormind", "vectormind.db"))) {
    upsertProject({
      name: "VectorMind-MCP",
      path: CURRENT_PROJECT_ROOT,
    });
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.trunc(parsed), max)) : fallback;
}

async function discoverMemoryProjects(rootPath, options = {}) {
  const root = realDirectoryPath(rootPath);
  const maxDepth = boundedInteger(options.maxDepth, 5, 1, 12);
  const maxDirs = boundedInteger(options.maxDirs, 8000, 100, 50000);
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  let cursor = 0;
  let scanned = 0;

  while (cursor < queue.length && scanned < maxDirs) {
    const current = queue[cursor];
    cursor += 1;
    scanned += 1;

    const dbPath = path.join(current.dir, ".vectormind", "vectormind.db");
    try {
      await fsp.access(dbPath, fs.constants.F_OK);
      found.push(current.dir);
      continue;
    } catch {
      // Continue traversing when this directory does not contain a memory database.
    }

    if (current.depth >= maxDepth) continue;

    let entries = [];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_SCAN_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith("$")) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  const unique = [...new Map(found.map((p) => [projectPathIdentity(p), p])).values()];
  return { root, scanned, found: unique };
}

const AUDIT_IGNORED_LIKE_PATTERNS = [
  ".tmp/%",
  "%/.tmp/%",
  ".tmp-%",
  ".tmp-%/%",
  "%/.tmp-%",
  "%/.tmp-%/%",
  "_tmp-%",
  "_tmp-%/%",
  "%/_tmp-%",
  "%/_tmp-%/%",
  "_tmp_%",
  "_tmp_%/%",
  "%/_tmp_%",
  "%/_tmp_%/%",
  "node_modules/%",
  "%/node_modules/%",
  "dist/%",
  "%/dist/%",
  "build/%",
  "%/build/%",
  ".vectormind/%",
  "%/.vectormind/%",
];

function ignoredPathWhereSql(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return AUDIT_IGNORED_LIKE_PATTERNS
    .map(() => `LOWER(REPLACE(${prefix}file_path, '\\', '/')) LIKE ?`)
    .join(" OR ");
}

function readMemoryAudit(project) {
  const dbPath = path.join(project.path, ".vectormind", "vectormind.db");
  const dbMain = fileInfo(dbPath);
  const base = {
    ok: true,
    dbPresent: dbMain.exists,
    dbPath,
    checkedAt: new Date().toISOString(),
    needsRepair: false,
    severity: "ok",
    summary: "未发现需要修复的记忆结构问题",
    counts: {},
    schema: {
      hasAggregateChangeColumns: false,
      hasSyncedFileStates: false,
    },
    duplicateChangeLogs: {
      groups: 0,
      rowsInGroups: 0,
      removableRows: 0,
      topGroups: [],
    },
    duplicateChangeIntents: {
      groups: 0,
      rowsInGroups: 0,
      removableRows: 0,
      topGroups: [],
    },
    ignoredPathNoise: {
      changeLogs: 0,
      indexedMemory: 0,
      symbols: 0,
    },
    lastRepair: null,
  };

  return withDb(project, (db) => {
    if (!db) {
      return {
        ...base,
        severity: "missing",
        summary: "未发现 .vectormind/vectormind.db",
      };
    }

    const counts = {
      requirements: safeCount(db, "requirements"),
      changeLogs: safeCount(db, "change_logs"),
      memoryItems: safeCount(db, "memory_items"),
      memoryItemsFts: safeCount(db, "memory_items_fts"),
      syncedFileStates: safeCount(db, "synced_file_states"),
      pendingChanges: safeCount(db, "pending_changes"),
      symbols: safeCount(db, "symbols"),
    };

    const hasAggregateChangeColumns =
      columnExists(db, "change_logs", "files_json") && columnExists(db, "change_logs", "file_count");
    const hasSyncedFileStates = tableExists(db, "synced_file_states");

    const duplicateChangeLogs = tableExists(db, "change_logs")
      ? safeGet(
          db,
          `SELECT COUNT(*) AS groups, COALESCE(SUM(row_count), 0) AS rowsInGroups
           FROM (
             SELECT COUNT(*) AS row_count
             FROM change_logs
             GROUP BY req_id, timestamp, intent_summary
             HAVING COUNT(*) > 1
                AND COUNT(DISTINCT COALESCE(file_path, '')) > 1
                AND SUM(CASE
                  WHEN json_type(CASE WHEN json_valid(files_json) THEN files_json ELSE 'null' END) = 'array' THEN 1
                  ELSE 0
                END) = 0
           )`,
        )
      : { groups: 0, rowsInGroups: 0 };

    const duplicateChangeIntents = tableExists(db, "memory_items")
      ? safeGet(
          db,
          `SELECT COUNT(*) AS groups, COALESCE(SUM(row_count), 0) AS rowsInGroups
           FROM (
             SELECT COUNT(*) AS row_count
             FROM memory_items
             WHERE kind = 'change_intent'
             GROUP BY req_id, content
             HAVING COUNT(*) > 1
                AND COUNT(DISTINCT COALESCE(file_path, '')) > 1
                AND SUM(CASE
                  WHEN json_type(
                    CASE WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}') ELSE '{}' END,
                    '$.files'
                  ) = 'array' THEN 1
                  ELSE 0
                END) = 0
           )`,
        )
      : { groups: 0, rowsInGroups: 0 };

    const duplicateChangeLogTopGroups = tableExists(db, "change_logs")
      ? safeAll(
          db,
          `WITH grouped AS (
             SELECT req_id, timestamp, intent_summary, COUNT(*) AS row_count, COUNT(DISTINCT COALESCE(file_path, '')) AS file_count
             FROM change_logs
             GROUP BY req_id, timestamp, intent_summary
             HAVING COUNT(*) > 1
                AND COUNT(DISTINCT COALESCE(file_path, '')) > 1
                AND SUM(CASE
                  WHEN json_type(CASE WHEN json_valid(files_json) THEN files_json ELSE 'null' END) = 'array' THEN 1
                  ELSE 0
                END) = 0
           )
           SELECT
             req_id,
             timestamp,
             substr(intent_summary, 1, 180) AS preview,
             row_count AS rows,
             file_count AS files,
             (
               SELECT GROUP_CONCAT(file_path, ' | ')
               FROM (
                 SELECT file_path
                 FROM change_logs AS c
                 WHERE c.req_id IS grouped.req_id
                   AND c.timestamp IS grouped.timestamp
                   AND c.intent_summary IS grouped.intent_summary
                 ORDER BY c.id ASC
                 LIMIT 6
               )
             ) AS sampleFiles
           FROM grouped
           ORDER BY row_count DESC, timestamp DESC
           LIMIT 8`,
        )
      : [];

    const duplicateChangeIntentTopGroups = tableExists(db, "memory_items")
      ? safeAll(
          db,
          `WITH grouped AS (
             SELECT req_id, content, COUNT(*) AS row_count, COUNT(DISTINCT COALESCE(file_path, '')) AS file_count
             FROM memory_items
             WHERE kind = 'change_intent'
             GROUP BY req_id, content
             HAVING COUNT(*) > 1
                AND COUNT(DISTINCT COALESCE(file_path, '')) > 1
                AND SUM(CASE
                  WHEN json_type(
                    CASE WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}') ELSE '{}' END,
                    '$.files'
                  ) = 'array' THEN 1
                  ELSE 0
                END) = 0
           )
           SELECT
             req_id,
             substr(content, 1, 180) AS preview,
             row_count AS rows,
             file_count AS files,
             (
               SELECT GROUP_CONCAT(file_path, ' | ')
               FROM (
                 SELECT file_path
                 FROM memory_items AS m
                 WHERE m.kind = 'change_intent'
                   AND m.req_id IS grouped.req_id
                   AND m.content IS grouped.content
                 ORDER BY m.id ASC
                 LIMIT 6
               )
             ) AS sampleFiles
           FROM grouped
           ORDER BY row_count DESC
           LIMIT 8`,
        )
      : [];

    const ignoredWhere = ignoredPathWhereSql();
    const ignoredPathNoise = {
      changeLogs: tableExists(db, "change_logs")
        ? safeCount(db, "change_logs", `WHERE file_path IS NOT NULL AND (${ignoredWhere})`, AUDIT_IGNORED_LIKE_PATTERNS)
        : 0,
      indexedMemory: tableExists(db, "memory_items")
        ? safeCount(db, "memory_items", `WHERE file_path IS NOT NULL AND (${ignoredWhere})`, AUDIT_IGNORED_LIKE_PATTERNS)
        : 0,
      symbols: tableExists(db, "symbols")
        ? safeCount(db, "symbols", `WHERE file_path IS NOT NULL AND (${ignoredWhere})`, AUDIT_IGNORED_LIKE_PATTERNS)
        : 0,
    };

    const lastRepairRow = tableExists(db, "meta_kv")
      ? safeGet(
          db,
          `SELECT value, updated_at
           FROM meta_kv
           WHERE key = 'maintenance:dedupe_change_records:last_run'
           LIMIT 1`,
        )
      : null;
    const lastRepair = lastRepairRow
      ? {
          updatedAt: lastRepairRow.updated_at,
          value: parseMaybeJson(lastRepairRow.value),
        }
      : null;

    const duplicateChangeLogGroups = Number(duplicateChangeLogs?.groups ?? 0);
    const duplicateChangeLogRows = Number(duplicateChangeLogs?.rowsInGroups ?? 0);
    const duplicateChangeIntentGroups = Number(duplicateChangeIntents?.groups ?? 0);
    const duplicateChangeIntentRows = Number(duplicateChangeIntents?.rowsInGroups ?? 0);
    const schemaNeedsRepair = !hasAggregateChangeColumns || !hasSyncedFileStates;
    const duplicateNeedsRepair = duplicateChangeLogGroups > 0 || duplicateChangeIntentGroups > 0;
    const needsRepair = schemaNeedsRepair || duplicateNeedsRepair;
    const severity = duplicateChangeLogRows > 1000 ? "critical" : duplicateNeedsRepair ? "warn" : schemaNeedsRepair ? "info" : "ok";
    const summary = duplicateNeedsRepair
      ? `发现 ${duplicateChangeLogGroups} 组重复改动日志、${duplicateChangeIntentGroups} 组重复改动记忆`
      : schemaNeedsRepair
        ? "数据库仍是旧结构，建议执行一次安全迁移"
        : "记忆结构正常，未发现重复改动日志";

    return {
      ...base,
      counts,
      schema: {
        hasAggregateChangeColumns,
        hasSyncedFileStates,
      },
      duplicateChangeLogs: {
        groups: duplicateChangeLogGroups,
        rowsInGroups: duplicateChangeLogRows,
        removableRows: Math.max(0, duplicateChangeLogRows - duplicateChangeLogGroups),
        topGroups: duplicateChangeLogTopGroups,
      },
      duplicateChangeIntents: {
        groups: duplicateChangeIntentGroups,
        rowsInGroups: duplicateChangeIntentRows,
        removableRows: Math.max(0, duplicateChangeIntentRows - duplicateChangeIntentGroups),
        topGroups: duplicateChangeIntentTopGroups,
      },
      ignoredPathNoise,
      lastRepair,
      needsRepair,
      severity,
      summary,
    };
  });
}

async function backupSqliteDatabase(dbPath) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupPath = path.join(backupDir, `vectormind-before-admin-repair-${stamp}.db`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (typeof db.backup === "function") {
      await db.backup(backupPath);
    } else {
      await fsp.copyFile(dbPath, backupPath);
    }
  } finally {
    db.close();
  }
  return backupPath;
}

async function repairProjectMemory(project) {
  const dbPath = path.join(project.path, ".vectormind", "vectormind.db");
  if (!fs.existsSync(dbPath)) {
    const error = new Error("未发现 .vectormind/vectormind.db，无法修复");
    error.status = 404;
    throw error;
  }

  const before = readMemoryAudit(project);
  const backupPath = await backupSqliteDatabase(dbPath);
  const runtimePath = path.join(CURRENT_PROJECT_ROOT, "dist", "database-runtime.js");
  if (!fs.existsSync(runtimePath)) {
    const error = new Error("核心修复模块尚未构建，请先运行 npm run build");
    error.status = 500;
    throw error;
  }

  const runtimeModule = await import(`${pathToFileURL(runtimePath).href}?t=${Date.now()}`);
  const runtime = runtimeModule.openDatabaseRuntime(project.path);
  try {
    runtime.db.close();
  } catch {
    // ignore close errors
  }

  const after = readMemoryAudit(project);
  return {
    ok: true,
    backupPath,
    before,
    after,
    memory: readProjectMemory(project),
  };
}

function sendError(res, err) {
  const status = Number(err?.status ?? 500);
  res.status(status).json({
    ok: false,
    error: err?.message ?? "请求失败",
  });
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use("/api", (req, res, next) => {
  const adminAuth = evaluateAdminRequest({
    policy: ADMIN_SECURITY,
    path: req.path,
    origin: req.get("origin"),
    hostHeader: req.get("host"),
    protocol: req.protocol,
    remoteAddress: req.socket.remoteAddress,
    providedToken: req.get(ADMIN_TOKEN_HEADER),
  });
  req.adminAuth = adminAuth;
  if (!adminAuth.originAllowed) {
    return res.status(403).json({ ok: false, error: "管理面板仅接受同源请求。" });
  }
  if (!adminAuth.authorized) {
    return res.status(403).json({ ok: false, error: "管理面板会话令牌无效。" });
  }
  return next();
});

app.get("/api/config", (req, res) => {
  ensureStorage();
  const automaticSession = req.adminAuth.exposeSessionToken;
  const authenticated = automaticSession || req.adminAuth.tokenValid;
  const config = {
    ok: true,
    host: HOST,
    port: PORT,
    platform: process.platform,
    authentication: {
      mode: ADMIN_SECURITY.mode,
      authenticated,
      requiresToken: ADMIN_SECURITY.mode === "explicit",
    },
  };
  if (automaticSession) config.sessionToken = ADMIN_TOKEN;
  if (authenticated) {
    Object.assign(config, {
      storageDir: STORAGE_DIR,
      indexFile: INDEX_FILE,
      homeDir: os.homedir(),
      currentProjectRoot: CURRENT_PROJECT_ROOT,
    });
  }
  res.json(config);
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "vectormind-admin-panel",
    status: "running",
    port: PORT,
    time: new Date().toISOString(),
  });
});

app.get("/api/projects", (_req, res) => {
  try {
    addCurrentProjectIfEmpty();
    const index = readIndex();
    res.json({
      ok: true,
      storage: {
        dir: STORAGE_DIR,
        file: INDEX_FILE,
        updatedAt: index.updatedAt,
      },
      projects: index.projects.map(summarizeProject),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/projects", (req, res) => {
  try {
    const record = upsertProject(req.body ?? {});
    res.status(201).json({ ok: true, project: summarizeProject(record) });
  } catch (err) {
    sendError(res, err);
  }
});

app.patch("/api/projects/:id", (req, res) => {
  try {
    const index = readIndex();
    const idx = index.projects.findIndex((p) => p.id === req.params.id);
    if (idx < 0) {
      const error = new Error("项目索引不存在。");
      error.status = 404;
      throw error;
    }
    const current = index.projects[idx];
    const nextInput = {
      id: current.id,
      name: req.body?.name ?? current.name,
      path: req.body?.path ?? current.path,
    };
    index.projects[idx] = toProjectRecord(nextInput, current);
    writeIndex(index);
    res.json({ ok: true, project: summarizeProject(index.projects[idx]) });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete("/api/projects/:id", (req, res) => {
  try {
    const index = readIndex();
    const before = index.projects.length;
    index.projects = index.projects.filter((p) => p.id !== req.params.id);
    if (index.projects.length === before) {
      const error = new Error("项目索引不存在。");
      error.status = 404;
      throw error;
    }
    writeIndex(index);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/projects/:id/memory", (req, res) => {
  try {
    const index = readIndex();
    const project = index.projects.find((p) => p.id === req.params.id);
    if (!project) {
      const error = new Error("项目索引不存在。");
      error.status = 404;
      throw error;
    }
    project.lastOpenedAt = new Date().toISOString();
    project.updatedAt = project.updatedAt ?? project.lastOpenedAt;
    writeIndex(index);
    res.json({
      ok: true,
      project,
      memory: readProjectMemory(project),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/projects/:id/memory/audit", (req, res) => {
  try {
    const index = readIndex();
    const project = index.projects.find((p) => p.id === req.params.id);
    if (!project) {
      const error = new Error("项目索引不存在");
      error.status = 404;
      throw error;
    }
    res.json({ ok: true, audit: readMemoryAudit(project) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/projects/:id/memory/repair", async (req, res) => {
  try {
    const index = readIndex();
    const project = index.projects.find((p) => p.id === req.params.id);
    if (!project) {
      const error = new Error("项目索引不存在");
      error.status = 404;
      throw error;
    }
    const result = await repairProjectMemory(project);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/projects/discover", async (req, res) => {
  try {
    const root = req.body?.root || os.homedir();
    const result = await discoverMemoryProjects(root, {
      maxDepth: req.body?.maxDepth,
      maxDirs: req.body?.maxDirs,
    });
    const records = result.found.map((projectPath) => upsertProject({ path: projectPath }));
    res.json({
      ok: true,
      root: result.root,
      scanned: result.scanned,
      found: result.found.length,
      projects: records.map(summarizeProject),
    });
  } catch (err) {
    sendError(res, err);
  }
});

async function attachFrontend() {
  const development = process.argv.includes("--development") || process.env.NODE_ENV === "development";

  if (development) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: CLIENT_DIR,
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: {
          port: PORT + 1,
        },
      },
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      try {
        const template = await fsp.readFile(path.join(CLIENT_DIR, "index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).type("html").send(html);
      } catch (err) {
        vite.ssrFixStacktrace(err);
        next(err);
      }
    });
    return;
  }

  app.use(express.static(DIST_DIR));
  app.use(async (req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    try {
      res.sendFile(path.join(DIST_DIR, "index.html"));
    } catch (err) {
      next(err);
    }
  });
}

ensureStorage();
await attachFrontend();

const server = app.listen(PORT, HOST, () => {
  console.log(`VectorMind 管理面板运行中: http://${HOST}:${PORT}`);
  console.log(`认证模式: ${ADMIN_SECURITY.mode === "automatic" ? "回环自动会话" : "显式令牌"}`);
  console.log(`项目索引文件: ${INDEX_FILE}`);
});

globalThis.__vectormindAdminServer = server;
