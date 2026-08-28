import assert from "node:assert/strict";
import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const requiredFiles = ["LICENSE", "NOTICE", "LICENSING.md", "CONTRIBUTING.md"];

assert.equal(packageJson.license, "SEE LICENSE IN LICENSE");
assert.equal(packageLock.packages?.[""]?.license, packageJson.license);
assert.equal(packageJson.author, "yuanfeng-net");
assert.equal(packageJson.repository?.url, "git+https://github.com/yuanfeng-net/VectorMind.git");

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `${file} must exist`);
  assert.equal(packageJson.files?.includes(file), true, `${file} must be included in the npm package`);
}

const license = fs.readFileSync("LICENSE", "utf8");
assert.match(license, /irrevocable except as provided in Section 7/u);
assert.match(license, /"Authorized Users" means/u);
assert.match(license, /3\. Outputs and Independent Work/u);
assert.match(license, /claims no\s+copyright or license rights in those Outputs/u);
assert.match(license, /Third-Party\s+Materials remain subject exclusively/u);

console.log("license package checks: ok");
