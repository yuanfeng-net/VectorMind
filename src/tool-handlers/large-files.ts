import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import type { RequirementRow } from "../types.js";
import { DEVELOPMENT_HUGE_FILE_LINES } from "../config.js";
import { PlanLargeFileSplitArgsSchema, RecordLargeFileSplitArgsSchema } from "../tool-schemas.js";
import { countFileLinesBounded, isLikelySourceImplementationFile } from "../development-warnings.js";
import { buildLargeFileSplitPlan, hasOrdinalModuleName } from "../large-file-split.js";
import { toolCompactOrJson } from "../token-savings.js";
import { flushPendingChangeBuffer } from "../file-indexing.js";
import { logActivity } from "../activity-log.js";
import { resolveProjectPathUnderRoot, resolveReadPathUnderProjectRoot } from "../project-files.js";
import { compactLargeFileSplitPlanText, safeJson, toolJson } from "../tool-output.js";
export async function handlePlanLargeFileSplit(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const projectRoot = context.getProjectRoot();
  const normalizeToDbPath = context.normalizeToDbPath;

  const args = PlanLargeFileSplitArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const resolved = resolveReadPathUnderProjectRoot(projectRoot, normalizeToDbPath, args.file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.absPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toolJson({ ok: false, error: `File not found: ${String(err)}` }) }],
    };
  }
  if (!stat.isFile()) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: "Not a file" }) }] };
  }
  if (!isLikelySourceImplementationFile(resolved.dbFilePath)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "Not a recognized source implementation file",
            file_path: resolved.dbFilePath,
          }),
        },
      ],
    };
  }

  const lineInfo = countFileLinesBounded(resolved.absPath, 8_000_000);
  const lineCount = lineInfo?.lines ?? 0;
  if (lineCount < DEVELOPMENT_HUGE_FILE_LINES) {
    return {
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            file_path: resolved.dbFilePath,
            line_count: lineInfo?.truncated ? `${lineCount}+` : lineCount,
            huge_threshold_lines: DEVELOPMENT_HUGE_FILE_LINES,
            recommended_action:
              "This file is not above the huge-file threshold. Use normal focused modularity rules unless the user explicitly asked for refactoring.",
          }),
        },
      ],
    };
  }

  let targetDir = args.target_dir;
  if (targetDir) {
    targetDir = resolveProjectPathUnderRoot(projectRoot, normalizeToDbPath, targetDir, { allowRoot: true }).dbFilePath;
  }
  const plan = buildLargeFileSplitPlan({
    filePath: resolved.dbFilePath,
    absPath: resolved.absPath,
    intent: args.intent,
    targetDir,
    maxModules: args.max_modules,
    hugeThresholdLines: DEVELOPMENT_HUGE_FILE_LINES,
  });

  logActivity("plan_large_file_split", {
    file_path: plan.file_path,
    line_count: plan.line_count,
    target_dir: plan.target_dir,
    modules: plan.modules.map((m) => m.module),
  });

  return {
    content: [
      {
        type: "text",
        text: toolCompactOrJson("plan_large_file_split", plan, compactLargeFileSplitPlanText(plan), args.format),
      },
    ],
  };
}
export async function handleRecordLargeFileSplit(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const normalizeToDbPath = context.normalizeToDbPath;
  const sha256Hex = context.sha256Hex;
  const { insertMemoryItemStmt, getActiveRequirementStmt } = context.getStatements();

  const args = RecordLargeFileSplitArgsSchema.parse(rawArgs);
  flushPendingChangeBuffer();
  const normalizedFile = normalizeToDbPath(args.file);
  const active = getActiveRequirementStmt.get() as RequirementRow | undefined;
  const modules = (args.modules ?? []).map(normalizeToDbPath);
  const ordinalModules = modules.filter(hasOrdinalModuleName);
  if (ordinalModules.length) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: toolJson({
            ok: false,
            error: "Ordinal-prefixed module file names are not allowed for mechanical modularization.",
            file_path: normalizedFile,
            invalid_modules: ordinalModules,
            required_naming:
              "Use stable semantic names such as config.ts, api.ts, service.ts, storage.ts, ui.ts, or maintenance.ts; do not use 1_xxx, 2_xxx, 03-xxx, or other ordering prefixes.",
          }),
        },
      ],
    };
  }
  const content = [
    `Huge-file mechanical modularization ${args.status}: ${normalizedFile}`,
    "",
    args.summary,
    modules.length ? `\nModules:\n${modules.map((m) => `- ${m}`).join("\n")}` : "",
    args.remaining_lines != null ? `\nRemaining lines: ${args.remaining_lines}` : "",
  ].filter(Boolean).join("\n");
  const meta = {
    tags: ["large-file-split", "mechanical-modularization"],
    file: normalizedFile,
    status: args.status,
    modules,
    remaining_lines: args.remaining_lines ?? null,
    active_requirement_id: active?.id ?? null,
  };
  const info = insertMemoryItemStmt.run(
    "note",
    `large-file-split:${normalizedFile}:${args.status}`,
    content,
    normalizedFile,
    null,
    null,
    active?.id ?? null,
    safeJson(meta),
    sha256Hex(content),
  );
  const id = Number(info.lastInsertRowid);
  logActivity("record_large_file_split", {
    memory_item_id: id,
    file_path: normalizedFile,
    status: args.status,
    modules: modules.slice(0, 20),
    remaining_lines: args.remaining_lines ?? null,
  });

  return {
    content: [
      {
        type: "text",
        text: toolJson({
          ok: true,
          note: { id },
          file_path: normalizedFile,
          status: args.status,
          modules,
          remaining_lines: args.remaining_lines ?? null,
        }),
      },
    ],
  };
}
