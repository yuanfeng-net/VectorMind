import crypto from "node:crypto";

export const ADMIN_TOKEN_HEADER = "x-vectormind-admin-token";

function normalizeHostname(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function effectivePort(protocol, port) {
  if (port) return Number(port);
  return protocol === "https:" ? 443 : 80;
}

function parseRequestHost(hostHeader, protocol = "http") {
  if (!hostHeader) return null;
  const normalizedProtocol = String(protocol).endsWith(":") ? String(protocol) : `${protocol}:`;
  try {
    const url = new URL(`${normalizedProtocol}//${hostHeader}`);
    return {
      hostname: normalizeHostname(url.hostname),
      port: effectivePort(url.protocol, url.port),
      protocol: url.protocol,
    };
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

export function isLoopbackAddress(address) {
  const normalized = String(address ?? "").trim().toLowerCase().split("%")[0];
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackHostname(normalized.slice(7));
  return isLoopbackHostname(normalized);
}

export function isAllowedAdminOrigin({ origin, hostHeader, protocol = "http" }) {
  if (!origin) return true;
  const requestHost = parseRequestHost(hostHeader, protocol);
  if (!requestHost) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return false;
    return (
      normalizeHostname(parsedOrigin.hostname) === requestHost.hostname &&
      effectivePort(parsedOrigin.protocol, parsedOrigin.port) === requestHost.port &&
      parsedOrigin.protocol === requestHost.protocol
    );
  } catch {
    return false;
  }
}

function tokensEqual(providedToken, expectedToken) {
  if (!providedToken || !expectedToken) return false;
  const provided = Buffer.from(String(providedToken));
  const expected = Buffer.from(String(expectedToken));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

export function createAdminSecurityPolicy({ host, port, configuredToken, generateToken } = {}) {
  const normalizedHost = normalizeHostname(host);
  const normalizedPort = Number(port);
  if (!normalizedHost || !Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error("管理面板监听地址或端口无效。");
  }

  const mode = isLoopbackHostname(normalizedHost) ? "automatic" : "explicit";
  const explicitToken = String(configuredToken ?? "").trim();
  if (mode === "explicit" && !explicitToken) {
    throw new Error("非回环监听必须设置 VECTORMIND_ADMIN_TOKEN。");
  }

  const token = explicitToken || (generateToken ? generateToken() : crypto.randomBytes(32).toString("hex"));
  return Object.freeze({ host: normalizedHost, port: normalizedPort, mode, token });
}

export function evaluateAdminRequest({
  policy,
  path,
  origin,
  hostHeader,
  protocol = "http",
  remoteAddress,
  providedToken,
}) {
  const originAllowed = isAllowedAdminOrigin({ origin, hostHeader, protocol });
  const requestHost = parseRequestHost(hostHeader, protocol);
  const tokenValid = tokensEqual(providedToken, policy.token);
  const publicEndpoint = path === "/config" || path === "/health";
  const automaticSessionAvailable = Boolean(
    policy.mode === "automatic" &&
      originAllowed &&
      requestHost &&
      requestHost.port === policy.port &&
      isLoopbackHostname(requestHost.hostname) &&
      isLoopbackAddress(remoteAddress),
  );

  return {
    originAllowed,
    tokenValid,
    publicEndpoint,
    authorized: originAllowed && (publicEndpoint || tokenValid),
    exposeSessionToken: path === "/config" && automaticSessionAvailable,
  };
}
