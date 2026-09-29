// Build-time trust anchors for deployments that serve the web app and API from
// different origins. Prefer enterprise-managed values in managed-policy-schema.json.
// Entries must be exact origins, for example: "https://exam.example.edu".
export const BUILD_TRUSTED_APP_ORIGINS = [];
export const BUILD_TRUSTED_API_ORIGINS = [];

export const PROTOCOL_VERSION = 1;
export const RUNTIME_STORAGE_KEY = "accessguardRuntime";
export const DEPLOYMENT_STORAGE_KEY = "accessguardDeployment";
export const POLICY_ALARM = "accessguard-policy-refresh";
export const POLICY_REFRESH_MINUTES = 0.5;
// Keep policy fetches below the web bridge's 8 second ARM timeout.
export const FETCH_TIMEOUT_MS = 7_000;
export const MAX_ALLOWED_ORIGINS = 500;

export const POLICY_PATH = "/public/extension/policy";
export const HEARTBEAT_PATH = "/public/extension/heartbeat";
export const ACCESS_REQUEST_PATH = "/public/extension/access-requests";

export const INVIGILATOR_AUTH_STORAGE_KEY = "accessguardInvigilatorAuth";
export const ACTIVE_QUICK_SESSION_STORAGE_KEY = "accessguardActiveQuickSession";
export const AUTH_LOGIN_PATH = "/auth/login";
export const SESSIONS_PATH = "/sessions";
