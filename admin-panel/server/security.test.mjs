import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminSecurityPolicy,
  evaluateAdminRequest,
  isAllowedAdminOrigin,
  isLoopbackAddress,
  isLoopbackHostname,
} from "./security.mjs";

test("loopback detection accepts only concrete loopback hosts and addresses", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.15.2.9"), true);
  assert.equal(isLoopbackHostname("localhost.example.com"), false);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.8"), false);
});

test("origin validation requires the browser origin to match the request host", () => {
  assert.equal(
    isAllowedAdminOrigin({ origin: "http://localhost:16860", hostHeader: "localhost:16860", protocol: "http" }),
    true,
  );
  assert.equal(
    isAllowedAdminOrigin({ origin: "http://evil.example:16860", hostHeader: "localhost:16860", protocol: "http" }),
    false,
  );
});

test("loopback mode exposes an automatic session only to a loopback request host", () => {
  const policy = createAdminSecurityPolicy({
    host: "127.0.0.1",
    port: 16860,
    generateToken: () => "automatic-test-token",
  });
  const localConfig = evaluateAdminRequest({
    policy,
    path: "/config",
    hostHeader: "localhost:16860",
    remoteAddress: "::ffff:127.0.0.1",
  });
  const reboundConfig = evaluateAdminRequest({
    policy,
    path: "/config",
    hostHeader: "attacker.example:16860",
    remoteAddress: "127.0.0.1",
  });

  assert.equal(policy.mode, "automatic");
  assert.equal(localConfig.exposeSessionToken, true);
  assert.equal(reboundConfig.exposeSessionToken, false);
});

test("non-loopback mode requires an explicit token and never exposes it through config", () => {
  assert.throws(
    () => createAdminSecurityPolicy({ host: "0.0.0.0", port: 16860 }),
    /VECTORMIND_ADMIN_TOKEN/,
  );
  const policy = createAdminSecurityPolicy({ host: "0.0.0.0", port: 16860, configuredToken: "explicit-test-token" });
  const configRequest = evaluateAdminRequest({
    policy,
    path: "/config",
    hostHeader: "192.168.1.20:16860",
    remoteAddress: "192.168.1.30",
  });
  const unauthenticatedRequest = evaluateAdminRequest({
    policy,
    path: "/projects",
    hostHeader: "192.168.1.20:16860",
    remoteAddress: "192.168.1.30",
  });
  const authenticatedRequest = evaluateAdminRequest({
    policy,
    path: "/projects",
    hostHeader: "192.168.1.20:16860",
    remoteAddress: "192.168.1.30",
    providedToken: "explicit-test-token",
  });

  assert.equal(policy.mode, "explicit");
  assert.equal(configRequest.exposeSessionToken, false);
  assert.equal(unauthenticatedRequest.authorized, false);
  assert.equal(authenticatedRequest.authorized, true);
});

test("a missing Origin does not authorize a protected endpoint without a token", () => {
  const policy = createAdminSecurityPolicy({ host: "10.0.0.4", port: 16860, configuredToken: "explicit-test-token" });
  const decision = evaluateAdminRequest({
    policy,
    path: "/projects/discover",
    origin: undefined,
    hostHeader: "10.0.0.4:16860",
    remoteAddress: "10.0.0.5",
  });
  assert.equal(decision.originAllowed, true);
  assert.equal(decision.authorized, false);
});

test("a mismatched Origin is rejected even when the token is valid", () => {
  const policy = createAdminSecurityPolicy({ host: "0.0.0.0", port: 16860, configuredToken: "explicit-test-token" });
  const decision = evaluateAdminRequest({
    policy,
    path: "/projects",
    origin: "http://evil.example:16860",
    hostHeader: "192.168.1.20:16860",
    remoteAddress: "192.168.1.30",
    providedToken: "explicit-test-token",
  });
  assert.equal(decision.originAllowed, false);
  assert.equal(decision.authorized, false);
});
