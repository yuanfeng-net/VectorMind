import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteTextFile, projectPathIdentity } from "./storage.mjs";

test("project path identity is case-sensitive except on Windows", () => {
  assert.equal(projectPathIdentity("", "linux"), "");
  assert.notEqual(projectPathIdentity("/tmp/VectorMind", "linux"), projectPathIdentity("/tmp/vectormind", "linux"));
  assert.equal(projectPathIdentity("/tmp/VectorMind", "win32"), projectPathIdentity("/tmp/vectormind", "win32"));
});

test("atomic writes replace the index and preserve the prior file when rename fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-admin-storage-"));
  const indexFile = path.join(root, "projects.json");
  try {
    fs.writeFileSync(indexFile, "old\n", "utf8");
    atomicWriteTextFile(indexFile, "new\n");
    assert.equal(fs.readFileSync(indexFile, "utf8"), "new\n");

    const failingFs = Object.create(fs);
    failingFs.renameSync = () => {
      throw new Error("simulated interrupted replace");
    };
    assert.throws(
      () => atomicWriteTextFile(indexFile, "truncated\n", { fsImpl: failingFs }),
      /simulated interrupted replace/,
    );
    assert.equal(fs.readFileSync(indexFile, "utf8"), "new\n");
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
