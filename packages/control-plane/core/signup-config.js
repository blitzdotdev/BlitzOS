// @ts-check

// These deployment settings are plain [vars], so the deploy script can read
// them from wrangler.toml before the Worker ever runs. Their parsers throw and
// run per request inside runtimeFor, so one bad value 500s every request and
// cron. This module is the ONE parser both sides use: core/runtime.ts re-exports
// it for the Worker, and scripts/deploy-helpers.mjs rejects the same values at
// deploy time. A copy would let the gate and runtime disagree.

/** @typedef {"open" | "invite"} SignupMode */
/** @typedef {"deployment-fallback" | "byok-required"} CloudWorkspaceCredentialPolicy */

/**
 * @param {string | null | undefined} value
 * @returns {CloudWorkspaceCredentialPolicy}
 */
export function cloudWorkspaceCredentialPolicyFromEnv(value) {
  const policy = (value ?? "").trim().toLowerCase();
  if (policy === "" || policy === "deployment-fallback") return "deployment-fallback";
  if (policy === "byok-required") return policy;
  throw new Error(
    "CLOUD_WORKSPACE_CREDENTIAL_POLICY must be deployment-fallback or byok-required",
  );
}

/**
 * @param {string | null | undefined} value
 * @returns {SignupMode}
 */
export function signupModeFromEnv(value) {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "" || mode === "open") return "open";
  if (mode === "invite") return "invite";
  throw new Error("SIGNUP_MODE must be 'open' or 'invite'");
}

const EMAIL_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/**
 * @param {string | null | undefined} value
 * @returns {readonly string[]}
 */
export function allowedEmailDomainsFromEnv(value) {
  const raw = (value ?? "").trim();
  if (raw === "") return [];
  const domains = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  for (const domain of domains) {
    if (!EMAIL_DOMAIN_PATTERN.test(domain)) {
      throw new Error(
        "ALLOWED_EMAIL_DOMAINS entries must be bare domains like example.com",
      );
    }
  }
  return domains;
}
