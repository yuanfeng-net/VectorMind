import path from "node:path";

import type { ExtractedSymbol } from "./types.js";

export function extractSymbols(filePath: string, content: string): ExtractedSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") return extractPythonSymbols(content);
  if (ext === ".rs") return extractRustSymbols(content);
  if (ext === ".go") return extractGoSymbols(content);
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return extractJsTsSymbols(content);
  }
  return extractCLikeSymbols(content);
}

function extractJsTsSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;

    match = trimmed.match(/^(export\s+)?(default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (match) {
      symbols.push({ name: match[3], type: "class", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[3], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "interface", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match) {
      symbols.push({ name: match[2], type: "type", signature: trimmed });
      continue;
    }

    match = trimmed.match(/^(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      symbols.push({ name: match[2], type: "enum", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(.*=>/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }

    match = trimmed.match(
      /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?function\s*\(/,
    );
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractPythonSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^class\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[1], type: "class", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractRustSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^(pub\s+)?(struct|enum|trait)\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      symbols.push({ name: match[3], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^(pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[2], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractGoSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
    if (match) {
      symbols.push({ name: match[1], type: match[2], signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
    match = trimmed.match(/^func\s+\([^)]*\)\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "method", signature: trimmed });
      continue;
    }
  }
  return symbols;
}

function extractCLikeSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"))
      continue;

    let match: RegExpMatchArray | null;
    match = trimmed.match(
      /^(class|struct|interface|enum)\s+([A-Za-z_][\w]*)\b/,
    );
    if (match) {
      symbols.push({ name: match[2], type: match[1], signature: trimmed });
      continue;
    }

    match = trimmed.match(/^[A-Za-z_][\w:<>,\s\*&]*\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      symbols.push({ name: match[1], type: "function", signature: trimmed });
      continue;
    }
  }
  return symbols;
}
