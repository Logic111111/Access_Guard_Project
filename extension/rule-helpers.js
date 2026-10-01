export const OWNED_RULE_ID_MIN = 740_000;
export const BLOCK_RULE_ID = OWNED_RULE_ID_MIN;
export const ALLOW_RULE_ID_START = OWNED_RULE_ID_MIN + 100;
export const OWNED_RULE_ID_MAX = 749_999;

export const ENFORCED_POLICY_STATES = Object.freeze([
  "armed",
  "enforced",
  "locked",
]);

export const RELEASE_POLICY_STATES = Object.freeze([
  "released",
  "finished",
  "kicked",
  "rejected",
  "ended",
]);

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Origin must be a non-empty string");
  }

  const parsed = new URL(value.trim());
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError("Only HTTP(S) origins are supported");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Origins must not contain credentials");
  }
  return parsed.origin;
}

export function normalizeOriginList(values = []) {
  if (!Array.isArray(values)) {
    throw new TypeError("Allowed origins must be an array");
  }

  const seen = new Set();
  for (const value of values) {
    seen.add(normalizeOrigin(value));
  }
  return [...seen].sort();
}

export function normalizeApiBase(value, appOrigin) {
  const normalizedAppOrigin = normalizeOrigin(appOrigin);
  const raw = typeof value === "string" && value.trim() ? value.trim() : "/api";
  const parsed = new URL(raw, `${normalizedAppOrigin}/`);

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError("API base must use HTTP(S)");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("API base must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError("API base must not contain a query or fragment");
  }

  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/api";
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function isLoopbackOrigin(value) {
  try {
    const { hostname } = new URL(normalizeOrigin(value));
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isSecureOrLoopbackOrigin(value) {
  try {
    const origin = normalizeOrigin(value);
    return new URL(origin).protocol === "https:" || isLoopbackOrigin(origin);
  } catch {
    return false;
  }
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function originRegex(origin) {
  return `^${escapeRegex(normalizeOrigin(origin))}(?:/|$)`;
}

export function compileNavigationRules(origins, maxOrigins = 500) {
  const allowedOrigins = normalizeOriginList(origins);
  if (allowedOrigins.length > maxOrigins) {
    throw new RangeError(`Policy contains more than ${maxOrigins} allowed origins`);
  }

  const rules = [
    {
      id: BLOCK_RULE_ID,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter: "^https?://",
        resourceTypes: ["main_frame"],
      },
    },
  ];

  allowedOrigins.forEach((origin, index) => {
    rules.push({
      id: ALLOW_RULE_ID_START + index,
      priority: 100,
      action: { type: "allow" },
      condition: {
        regexFilter: originRegex(origin),
        resourceTypes: ["main_frame"],
      },
    });
  });

  return rules;
}

export function isOwnedRuleId(ruleId) {
  return Number.isInteger(ruleId) && ruleId >= OWNED_RULE_ID_MIN && ruleId <= OWNED_RULE_ID_MAX;
}

export function isAllowedHttpNavigation(value, allowedOrigins) {
  try {
    const parsed = new URL(value);
    if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
      return false;
    }
    return new Set(normalizeOriginList(allowedOrigins)).has(parsed.origin);
  } catch {
    return false;
  }
}

export function sanitizeAttemptedUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Attempted URL is required");
  }
  const parsed = new URL(value.trim());
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError("Only HTTP(S) access may be requested");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("URLs containing credentials cannot be requested");
  }
  parsed.hash = "";
  const sanitized = parsed.toString();
  if (sanitized.length > 2048) {
    throw new RangeError("Attempted URL is too long");
  }
  return sanitized;
}

export function normalizeExamUrl(value, appOrigin, fallbackUrl = null) {
  const pinnedOrigin = normalizeOrigin(appOrigin);
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : fallbackUrl;
  if (!raw) return null;

  let parsed = new URL(raw, `${pinnedOrigin}/`);
  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("Policy exam_url must be an HTTP(S) URL without credentials");
  }

  // The page that arms the extension is the authority for the application
  // origin. Deployment defaults (for example localhost vs. 127.0.0.1 or a LAN
  // hostname) must not move the student to a different storage origin. Keep the
  // authenticated policy path/query, but pin it to the exact sender origin. An
  // origin-only deployment default carries no useful route, so preserve the
  // armed page route instead of sending the student to the landing page.
  if (parsed.origin !== pinnedOrigin) {
    if (parsed.pathname === "/" && !parsed.search && fallbackUrl) {
      return normalizeExamUrl(fallbackUrl, pinnedOrigin);
    }
    parsed = new URL(`${parsed.pathname}${parsed.search}`, `${pinnedOrigin}/`);
  }

  parsed.hash = "";
  return parsed.toString();
}

export function normalizePolicy(raw, expected, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Policy response must be an object");
  }

  const state = String(raw.state || "").trim().toLowerCase();
  if (![...ENFORCED_POLICY_STATES, ...RELEASE_POLICY_STATES].includes(state)) {
    throw new TypeError(`Unsupported policy state: ${state || "missing"}`);
  }

  const candidateId = String(raw.candidate_id || "").trim();
  if (!candidateId || candidateId !== String(expected.candidateId || "")) {
    throw new TypeError("Policy candidate does not match the armed candidate");
  }

  const sessionId = String(raw.session_id || "").trim();
  if (!sessionId) {
    throw new TypeError("Policy session_id is required");
  }

  if (raw.policy_version === undefined || raw.policy_version === null || raw.policy_version === "") {
    throw new TypeError("Policy policy_version is required");
  }
  const policyVersion = String(raw.policy_version);

  const generatedAt = raw.issued_at || raw.timestamps?.generated_at || null;
  let issuedAt = null;
  if (generatedAt) {
    const issuedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(issuedAtMs)) {
      throw new TypeError("Policy generated timestamp must be valid");
    }
    if (issuedAtMs > now + 5 * 60_000) {
      throw new TypeError("Policy generated timestamp is in the future");
    }
    issuedAt = new Date(issuedAtMs).toISOString();
  }

  let expiresAt = null;
  if (raw.expires_at) {
    const expiresAtMs = Date.parse(raw.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new TypeError("Policy expires_at must be a valid timestamp");
    }
    if (expiresAtMs <= now) {
      throw new TypeError("Policy response has expired");
    }
    expiresAt = new Date(expiresAtMs).toISOString();
  }

  const appOrigins = normalizeOriginList(raw.app_origins || []);
  const allowedOrigins = normalizeOriginList(raw.allowed_origins || []);
  const examUrl = normalizeExamUrl(raw.exam_url, expected.appOrigin, expected.examUrl);

  const enforced = ENFORCED_POLICY_STATES.includes(state) && raw.enforcement !== false;
  if (enforced && !examUrl) {
    throw new TypeError("An enforced policy requires exam_url");
  }

  return {
    candidateId,
    sessionId,
    state,
    policyVersion,
    enforcement: enforced,
    examUrl,
    appOrigins,
    allowedOrigins,
    issuedAt,
    expiresAt,
    signature: typeof raw.signature === "string" ? raw.signature : null,
  };
}
