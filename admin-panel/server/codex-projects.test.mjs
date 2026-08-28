import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexGlobalStatePath,
  readCodexLocalProjects,
  syncCodexProjectRecords,
} from "./codex-projects.mjs";

test("reads existing Codex local projects in Codex sidebar order", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-codex-projects-"));
  const codexHome = path.join(base, "codex-home");
  const alpha = path.join(base, "alpha");
  const beta = path.join(base, "beta");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(alpha);
  fs.mkdirSync(beta);
  const statePath = path.join(codexHome, ".codex-global-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    "project-order": ["beta-id", "alpha-id", "missing-id"],
    "local-projects": {
      "alpha-id": { name: "Alpha", rootPaths: [alpha], updatedAt: 1_700_000_000_000 },
      "missing-id": { name: "Missing", rootPaths: [path.join(base, "missing")] },
      "beta-id": { name: "Beta", rootPaths: [beta] },
    },
  }), "utf8");
  try {
    assert.equal(codexGlobalStatePath({ env: { CODEX_HOME: codexHome }, homeDir: base }), statePath);
    const result = readCodexLocalProjects({ env: { CODEX_HOME: codexHome }, homeDir: base });
    assert.equal(result.available, true);
    assert.equal(result.error, null);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.projects.map((project) => project.sourceName), ["Beta", "Alpha"]);
    assert.deepEqual(result.projects.map((project) => project.sourceProjectId), ["beta-id", "alpha-id"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("preserves manual records and removes only stale Codex records", () => {
  const now = "2026-08-28T00:00:00.000Z";
  const existing = [
    { id: "manual-beta", name: "Custom Beta", path: path.resolve("beta"), source: "manual" },
    { id: "stale", name: "Stale", path: path.resolve("stale"), source: "codex" },
    { id: "manual-only", name: "Manual", path: path.resolve("manual"), source: "manual" },
  ];
  const discovered = [
    { sourceProjectId: "alpha-id", sourceName: "Alpha", path: path.resolve("alpha"), sourceUpdatedAt: null },
    { sourceProjectId: "beta-id", sourceName: "Beta", path: path.resolve("beta"), sourceUpdatedAt: null },
  ];
  const result = syncCodexProjectRecords(existing, discovered, now);
  assert.equal(result.changed, true);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.projects.map((project) => project.name), ["Alpha", "Custom Beta", "Manual"]);
  assert.equal(result.projects[0].source, "codex");
  assert.equal(result.projects[1].source, "manual");
});

test("reports malformed Codex state without throwing or changing records", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-codex-malformed-"));
  const statePath = path.join(base, ".codex-global-state.json");
  fs.writeFileSync(statePath, "{invalid", "utf8");
  try {
    const result = readCodexLocalProjects({ env: { CODEX_HOME: base }, homeDir: base });
    assert.equal(result.available, true);
    assert.equal(result.projects.length, 0);
    assert.ok(result.error);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
