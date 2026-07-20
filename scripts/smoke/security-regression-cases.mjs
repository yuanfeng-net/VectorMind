import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureFileIndexing, indexFile, recordPendingChange, removeFileIndexes } from "../../dist/file-indexing.js";
import { runIndexedGrepSearch } from "../../dist/grep.js";
import { passesPathFilters } from "../../dist/path-filters.js";
import { RTK_COMMIT_SHA, verifyFileSha256 } from "../../dist/rtk-integrity.js";
import { buildRtkInstallPlan } from "../../dist/rtk-tools.js";

function runIndexContainmentCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-index-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-index-outside-"));
  const link = path.join(root, "outside-link");
  let normalized = 0;
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    configureFileIndexing({
      getDb: () => {
        throw new Error("out-of-root indexing reached the database");
      },
      getProjectRoot: () => root,
      normalizeToDbPath: () => {
        normalized += 1;
        return "outside-link/secret.txt";
      },
    });
    const escapedFile = path.join(link, "secret.txt");
    recordPendingChange(escapedFile, "add");
    indexFile(escapedFile, "manual");
    const missingEscapedFile = path.join(link, "missing.txt");
    recordPendingChange(missingEscapedFile, "unlink");
    removeFileIndexes(missingEscapedFile);
    assert.equal(normalized, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function runUnsafeRegexCase() {
  assert.throws(
    () => runIndexedGrepSearch({
      query: "anchor(a+)+$",
      mode: "regex",
      smartCase: false,
      caseSensitive: true,
      literalHint: "anchor",
      kinds: ["code_chunk"],
      includePaths: null,
      excludePaths: null,
      maxResults: 20,
      db: {},
      ftsAvailable: false,
      ftsTableName: "memory_fts",
      buildFtsMatchQuery: (raw) => raw,
      escapeLike: (raw) => raw,
    }),
    /Unsafe regex rejected/,
  );
}

function runRtkIntegrityCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-rtk-integrity-"));
  const file = path.join(root, "asset.bin");
  try {
    fs.writeFileSync(file, "trusted asset", "utf8");
    const digest = crypto.createHash("sha256").update("trusted asset").digest("hex");
    verifyFileSha256(file, digest);
    assert.throws(() => verifyFileSha256(file, "0".repeat(64)), /SHA-256 mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runRtkInstallPlanCase() {
  const common = {
    dry_run: true,
    uninstall_wrong_cargo_rtk: false,
    init: "none",
    timeout_ms: 120_000,
  };
  const cargoPlan = buildRtkInstallPlan({ ...common, method: "cargo" });
  assert.match(cargoPlan.commands.join("\n"), new RegExp(`--rev ${RTK_COMMIT_SHA}`));
  assert.match(cargoPlan.commands.join("\n"), /cargo install --locked /);
  assert.doesNotMatch(cargoPlan.commands.join("\n"), /releases\/latest|master\/install\.sh|curl\s+-fsSL/i);

  const shellPlan = buildRtkInstallPlan({ ...common, method: "shell_script" });
  assert.doesNotMatch(shellPlan.commands.join("\n"), /master\/install\.sh|curl\s+-fsSL/i);
  assert.ok(["package_shim", "cargo", "unavailable"].includes(shellPlan.method));
}

function runPathFilterCase() {
  assert.equal(passesPathFilters("src/Foo.ts", ["src/Foo.ts"], null, "linux"), true);
  assert.equal(passesPathFilters("src/foo.ts", ["src/Foo.ts"], null, "linux"), false);
  assert.equal(passesPathFilters("src/foo.ts", ["src/Foo.ts"], null, "win32"), true);
  assert.equal(passesPathFilters("src/foo.ts", null, ["src/Foo.ts"], "linux"), true);
  assert.equal(passesPathFilters("src/foo.ts", null, ["src/Foo.ts"], "win32"), false);
}

runIndexContainmentCase();
runUnsafeRegexCase();
runRtkIntegrityCase();
runRtkInstallPlanCase();
runPathFilterCase();
console.log("security regression cases passed");
