import Database from "better-sqlite3";

import type { OutputFormat } from "./tool-schemas.js";
import { estimateTokens, toolJson } from "./tool-output.js";

type TokenSavingsContext = {
  getDb: () => Database.Database | undefined;
  getInsertTokenSavingsStatement: () => Database.Statement | undefined;
  getSummarizeTokenSavingsStatement: () => Database.Statement;
  getSummarizeTokenSavingsByToolStatement: () => Database.Statement;
  getListRecentTokenSavingsStatement: () => Database.Statement;
};

let tokenSavingsContext: TokenSavingsContext | null = null;

export function configureTokenSavings(context: TokenSavingsContext): void {
  tokenSavingsContext = context;
}

function requireTokenSavingsContext(): TokenSavingsContext {
  if (!tokenSavingsContext) throw new Error("[VectorMind] token savings context is not configured");
  return tokenSavingsContext;
}

function recordTokenSavings(tool: string, rawText: string, outputText: string): void {
  const context = requireTokenSavingsContext();
  const db = context.getDb();
  const insertTokenSavingsStmt = context.getInsertTokenSavingsStatement();
  if (!db || !insertTokenSavingsStmt) return;

  const rawTokens = estimateTokens(rawText);
  const outputTokens = estimateTokens(outputText);
  const savedTokens = Math.max(0, rawTokens - outputTokens);
  const savingsPct = rawTokens > 0 ? (savedTokens / rawTokens) * 100 : 0;
  try {
    insertTokenSavingsStmt.run(tool, rawTokens, outputTokens, savedTokens, savingsPct);
  } catch (err) {
    console.error("[vectormind] token savings record failed:", err);
  }
}

export function toolText(
  tool: string,
  rawValue: unknown,
  compactText: string,
  format: "compact" | "json" = "compact",
): string {
  const rawText = toolJson(rawValue);
  if (format === "json") return rawText;
  recordTokenSavings(tool, rawText, compactText);
  return compactText;
}

export function toolCompactOrJson(
  tool: string,
  rawValue: unknown,
  compactText: string,
  format: OutputFormat,
): string {
  return toolText(tool, rawValue, compactText, format);
}

export function tokenSavingsSummary(limit: number) {
  const context = requireTokenSavingsContext();
  const summary = context.getSummarizeTokenSavingsStatement().get() as
    | {
        calls: number;
        raw_tokens: number;
        output_tokens: number;
        saved_tokens: number;
        avg_savings_pct: number;
      }
    | undefined;
  const by_tool = context.getSummarizeTokenSavingsByToolStatement().all(limit) as Array<{
    tool: string;
    calls: number;
    raw_tokens: number;
    output_tokens: number;
    saved_tokens: number;
    avg_savings_pct: number;
  }>;
  const recent = context.getListRecentTokenSavingsStatement().all(limit) as Array<{
    id: number;
    tool: string;
    raw_tokens: number;
    output_tokens: number;
    saved_tokens: number;
    savings_pct: number;
    created_at: string;
  }>;
  return {
    ok: true,
    summary: summary ?? { calls: 0, raw_tokens: 0, output_tokens: 0, saved_tokens: 0, avg_savings_pct: 0 },
    by_tool,
    recent,
  };
}
