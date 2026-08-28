import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  adminPanelAutoStartEnabled,
  scheduleAdminProjectRegistration,
  startAdminPanelIfEnabled,
} from "../../dist/admin-launcher.js";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, options, predicate, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const value = await response.json();
      if (response.ok && predicate(value)) return value;
      lastError = new Error(`unexpected response ${response.status}: ${JSON.stringify(value)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`);
}

assert.equal(adminPanelAutoStartEnabled({}), true);
for (const value of ["0", "false", "NO", "off", "disabled"]) {
  assert.equal(adminPanelAutoStartEnabled({ VECTORMIND_ADMIN_AUTO_START: value }), false);
}
assert.equal(startAdminPanelIfEnabled({ env: { VECTORMIND_ADMIN_AUTO_START: "false" } }).reason, "disabled");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "vectormind-admin-launcher-"));
const root = path.join(base, "project");
const home = path.join(base, "home");
const codexHome = path.join(base, "codex-home");
const codexRoot = path.join(base, "codex-project");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(codexRoot, { recursive: true });
fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
  "local-projects": {
    "codex-project-id": {
      id: "codex-project-id",
      name: "Codex smoke project",
      rootPaths: [codexRoot],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  },
  "project-order": ["codex-project-id"],
}));
const port = await freePort();
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  VECTORMIND_ADMIN_AUTO_START: "true",
  VECTORMIND_ADMIN_HOST: "127.0.0.1",
  VECTORMIND_ADMIN_PORT: String(port),
  VECTORMIND_ADMIN_PROJECT_ROOT: root,
  HOME: home,
  USERPROFILE: home,
};
const launch = startAdminPanelIfEnabled({ env, cwd: root });
assert.equal(launch.started, true);
assert.ok(launch.pid);

try {
  const config = await waitForJson(
    `${launch.url}/api/config`,
    undefined,
    (value) => value?.ok === true && value?.currentProjectRoot === root && typeof value?.sessionToken === "string",
  );
  const page = await fetch(`${launch.url}/`);
  assert.equal(page.ok, true);
  assert.match(await page.text(), /VectorMind/u);

  const headers = { "x-vectormind-admin-token": config.sessionToken };
  const firstProjectsResponse = await fetch(`${launch.url}/api/projects`, { headers });
  assert.equal(firstProjectsResponse.ok, true);
  const firstProjects = await firstProjectsResponse.json();
  assert.deepEqual(
    {
      imported: firstProjects.codexSync?.imported,
      added: firstProjects.codexSync?.added,
      error: firstProjects.codexSync?.error,
    },
    { imported: 1, added: 1, error: null },
  );
  assert.ok(firstProjects.projects?.some(
    (project) => project.path === fs.realpathSync.native(codexRoot) && project.source === "codex",
  ));

  scheduleAdminProjectRegistration(root, env);
  await waitForJson(
    `${launch.url}/api/projects`,
    { headers },
    (value) => value?.projects?.some((project) => project.path === root)
      && value?.projects?.some((project) => project.path === fs.realpathSync.native(codexRoot)),
  );
} finally {
  if (launch.pid) {
    try { process.kill(launch.pid, "SIGTERM"); } catch { /* Process already stopped. */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log("admin launcher regression cases: ok");
