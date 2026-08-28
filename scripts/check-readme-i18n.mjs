import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const languages = [
  { label: "简体中文", file: "README.md" },
  { label: "English", file: "README.en.md" },
  { label: "日本語", file: "README.ja.md" },
  { label: "한국어", file: "README.ko.md" },
  { label: "繁體中文", file: "README.zh-TW.md" },
];
const requiredLiterals = [
  "npx -y @coreyuan/vector-mind",
  "npm install -g @coreyuan/vector-mind",
  "VECTORMIND_ADMIN_HOST",
  "VECTORMIND_ADMIN_PORT",
  "VECTORMIND_ADMIN_TOKEN",
  "VECTORMIND_ADMIN_AUTO_START",
  "VECTORMIND_DEPLOYMENT_HOST",
  "VECTORMIND_PREPARED_SSH_TTL_SECONDS",
  "preflight_operation_scope",
  "prepare_secure_ssh",
  "safe_to_proceed",
  ".codex-global-state.json",
  "npm run verify",
  "npm publish --access public",
  "VectorMind Source-Available License 1.0",
];

function selectorFor(currentFile) {
  return languages
    .map(({ label, file }) => file === currentFile ? `**${label}**` : `[${label}](${file})`)
    .join(" | ");
}

function documentShape(text) {
  return {
    headingLevels: [...text.matchAll(/^(#{1,3})\s/gmu)].map((match) => match[1].length),
    fenceSequence: [...text.matchAll(/^```([^\r\n]*)/gmu)].map((match) => match[1]),
    bulletCount: [...text.matchAll(/^-\s/gmu)].length,
    tableRowCount: [...text.matchAll(/^\|.*\|\s*$/gmu)].length,
  };
}

function verifyLocalLinks(file, text) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const href = match[1].trim();
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(href)) continue;
    const target = href.split("#", 1)[0];
    assert.equal(
      fs.existsSync(path.resolve(path.dirname(file), target)),
      true,
      `${file} contains a missing local link target: ${target}`,
    );
  }
}

const referenceText = fs.readFileSync("README.md", "utf8");
const referenceShape = documentShape(referenceText);

for (const { file } of languages) {
  assert.equal(fs.existsSync(file), true, `${file} must exist`);
  const text = fs.readFileSync(file, "utf8");
  const firstLine = text.split(/\r?\n/u, 1)[0];
  assert.equal(firstLine, selectorFor(file), `${file} must use the canonical language selector`);
  assert.match(text, /^# VectorMind MCP$/mu);
  assert.equal(text.includes(`\`${packageJson.version}\``), true, `${file} must include the package version`);
  for (const literal of requiredLiterals) {
    assert.equal(text.includes(literal), true, `${file} must include ${literal}`);
  }
  assert.deepEqual(documentShape(text), referenceShape, `${file} must match the default README structure`);
  verifyLocalLinks(file, text);
}

for (const { file } of languages.slice(1)) {
  assert.equal(packageJson.files?.includes(file), true, `${file} must be included in the npm package`);
}

console.log("README language checks: ok");
