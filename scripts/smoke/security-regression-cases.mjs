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
import { sanitizePersistentMemoryText, sanitizePersistentMemoryValue } from "../../dist/memory-safety.js";
import { requirementOverlapScore } from "../../dist/context-governance.js";

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

function runPersistentMemoryRedactionCase() {
  const prefixedPassword = "plainsecret-prefixed-password";
  const quotedSecret = "multi word quoted secret";
  const sanitized = sanitizePersistentMemoryText([
    "Production domain=https://shop.example.test origin=203.0.113.9:443 deploy_dir=/srv/app",
    "SSH credential source: ops/server.txt",
    "GMPAY_SECRET_KEY=gms_thisMustNeverPersist123456789",
    '"bot_token":"123456789:abcdefghijklmnopqrstuvwxyzABCDEFG"',
    `DATABASE_PASSWORD=${prefixedPassword}`,
    `password: "${quotedSecret}"`,
    "Authorization: Bearer bearerSecretMustDisappear",
  ].join("\n"));
  assert.equal(sanitized.redacted, true);
  assert.match(sanitized.text, /shop\.example\.test/);
  assert.match(sanitized.text, /203\.0\.113\.9:443/);
  assert.match(sanitized.text, /ops\/server\.txt/);
  assert.doesNotMatch(sanitized.text, /thisMustNeverPersist|abcdefghijklmnopqrstuvwxyz|plainsecret-prefixed-password|multi word quoted secret|bearerSecretMustDisappear/);
  assert.ok(sanitized.text.includes('password: "[REDACTED]"'));

  const structured = sanitizePersistentMemoryValue({
    root_cause: `The deployment used DATABASE_PASSWORD=${prefixedPassword}`,
    nested: { api_key: "nestedSecretMustDisappear" },
  });
  assert.equal(structured.redacted, true);
  assert.doesNotMatch(JSON.stringify(structured.value), /plainsecret-prefixed-password|nestedSecretMustDisappear/);
}

function runRequirementOverlapCase() {
  const score = requirementOverlapScore(
    { title: "Deploy merchant catalog refresh", context_data: "Publish merchant catalog bundle to production origin." },
    { title: "Fix merchant catalog refresh deployment", background: "Continue production origin deployment after bundle verification." },
  );
  assert.ok(score >= 0.55, `expected strong lifecycle overlap, got ${score}`);
  const isolated = requirementOverlapScore(
    { title: "Implement transport request lifecycle", context_data: "Build request processing." },
    { title: "Debug transport timeout retries", background: "Investigate retry timing." },
  );
  assert.ok(isolated < 0.55, `expected a shared technical word not to force reuse, got ${isolated}`);
  const chineseOverlap = requirementOverlapScore(
    { title: "修复商店数据加载失败", context_data: "部署商品介绍后线上商店无法读取数据" },
    { title: "继续处理商店数据加载问题", background: "检查同一次部署导致的线上商家数据错误" },
  );
  assert.ok(chineseOverlap >= 0.55, `expected rewritten Chinese incident to overlap, got ${chineseOverlap}`);
  const chineseIsolated = requirementOverlapScore(
    { title: "优化商店商品加载速度", context_data: "减少列表渲染时间" },
    { title: "修复支付回调重复通知", background: "处理网关重试事件" },
  );
  assert.ok(chineseIsolated < 0.55, `expected unrelated Chinese tasks to remain separate, got ${chineseIsolated}`);
}

runIndexContainmentCase();
runUnsafeRegexCase();
runRtkIntegrityCase();
runRtkInstallPlanCase();
runPathFilterCase();
runPersistentMemoryRedactionCase();
runRequirementOverlapCase();
console.log("security regression cases passed");
