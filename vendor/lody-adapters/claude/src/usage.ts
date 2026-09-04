// https://github.com/jarrodwatts/claude-hud/tree/main

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { execFileSync } from "child_process";
import type { RateLimitWindow, RateLimitsSnapshot } from "acp-extension-core";

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
    expiresAt?: number; // Unix millisecond timestamp
    scopes?: string[];
  };
}

interface UsageApiResponse {
  five_hour?: {
    utilization?: number;
    resets_at?: string;
  };
  seven_day?: {
    utilization?: number;
    resets_at?: string;
  };
}

const KEYCHAIN_TIMEOUT_MS = 5000;
const KEYCHAIN_BACKOFF_MS = 60_000; // Backoff on keychain failures to avoid re-prompting

// Dependency injection for testing
export type UsageApiDeps = {
  homeDir: () => string;
  fetchApi: (accessToken: string) => Promise<UsageApiResponse | null>;
  now: () => number;
  readKeychain: (
    now: number,
    homeDir: string,
  ) => { accessToken: string; subscriptionType: string } | null;
};

const defaultDeps: UsageApiDeps = {
  homeDir: () => os.homedir(),
  fetchApi: fetchUsageApi,
  now: () => Date.now(),
  readKeychain: readKeychainCredentials,
};

/**
 * Get OAuth usage data from Anthropic API.
 * Returns null if user is an API user (no OAuth credentials) or credentials are expired.
 * Returns null when the account has no subscription quota or the API is unavailable.
 */
export async function getUsage(
  overrides: Partial<UsageApiDeps> = {},
): Promise<RateLimitsSnapshot | null> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const homeDir = deps.homeDir();

  try {
    const credentials = readCredentials(homeDir, now, deps.readKeychain);
    if (!credentials) {
      return null;
    }

    const { accessToken, subscriptionType } = credentials;

    // Determine plan name from subscriptionType
    const planName = getPlanName(subscriptionType);
    if (!planName) {
      // API user, no usage limits to show
      return null;
    }

    // Fetch usage from API
    const apiResponse = await deps.fetchApi(accessToken);
    if (!apiResponse) {
      return null;
    }

    // Parse response - API returns 0-100 percentage directly
    // Clamp to 0-100 and handle NaN/Infinity
    const fiveHour = parseUtilization(apiResponse.five_hour?.utilization);
    const sevenDay = parseUtilization(apiResponse.seven_day?.utilization);

    const fiveHourResetAt = parseDate(apiResponse.five_hour?.resets_at);
    const sevenDayResetAt = parseDate(apiResponse.seven_day?.resets_at);

    const windows: RateLimitWindow[] = [];
    if (fiveHour !== null) {
      windows.push({
        usedPercent: fiveHour,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: fiveHourResetAt,
      });
    }
    if (sevenDay !== null) {
      windows.push({
        usedPercent: sevenDay,
        windowDurationSeconds: 7 * 24 * 60 * 60,
        resetsAtEpochSeconds: sevenDayResetAt,
      });
    }

    const result: RateLimitsSnapshot = {
      rateLimits: [
        {
          limitId: "claude",
          scope: { providerId: "claude" },
          planName,
          windows,
        },
      ],
      fetchedAtEpochSeconds: Math.floor(now / 1000),
    };

    return result;
  } catch {
    return null;
  }
}

/**
 * Get path for keychain failure backoff cache.
 * Separate from usage cache to track keychain-specific failures.
 */
function getKeychainBackoffPath(homeDir: string): string {
  return path.join(homeDir, ".claude", "plugins", "claude-hud", ".keychain-backoff");
}

/**
 * Check if we're in keychain backoff period (recent failure/timeout).
 * Prevents re-prompting user on every render cycle.
 */
function isKeychainBackoff(homeDir: string, now: number): boolean {
  try {
    const backoffPath = getKeychainBackoffPath(homeDir);
    if (!fs.existsSync(backoffPath)) return false;
    const timestamp = parseInt(fs.readFileSync(backoffPath, "utf8"), 10);
    return now - timestamp < KEYCHAIN_BACKOFF_MS;
  } catch {
    return false;
  }
}

/**
 * Record keychain failure for backoff.
 */
function recordKeychainFailure(homeDir: string, now: number): void {
  try {
    const backoffPath = getKeychainBackoffPath(homeDir);
    const dir = path.dirname(backoffPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(backoffPath, String(now), "utf8");
  } catch {
    // Ignore write failures
  }
}

/**
 * Read credentials from macOS Keychain.
 * Claude Code 2.x stores OAuth credentials in the macOS Keychain under "Claude Code-credentials".
 * Returns null if not on macOS or credentials not found.
 *
 * Security: Uses execFileSync with absolute path to avoid shell injection and PATH hijacking.
 */
function readKeychainCredentials(
  now: number,
  homeDir: string,
): { accessToken: string; subscriptionType: string } | null {
  // Only available on macOS
  if (process.platform !== "darwin") {
    return null;
  }

  // Check backoff to avoid re-prompting on every render after a failure
  if (isKeychainBackoff(homeDir, now)) {
    return null;
  }

  try {
    // Read from macOS Keychain using security command
    // Security: Use execFileSync with absolute path and args array (no shell)
    const keychainData = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: KEYCHAIN_TIMEOUT_MS },
    ).trim();

    if (!keychainData) {
      return null;
    }

    const data: CredentialsFile = JSON.parse(keychainData);
    return parseCredentialsData(data, now);
  } catch {
    // Record failure for backoff to avoid re-prompting
    recordKeychainFailure(homeDir, now);
    return null;
  }
}

/**
 * Read credentials from file (legacy method).
 * Older versions of Claude Code stored credentials in ~/.claude/.credentials.json
 */
function readFileCredentials(
  homeDir: string,
  now: number,
): { accessToken: string; subscriptionType: string } | null {
  const credentialsPath = path.join(homeDir, ".claude", ".credentials.json");

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(credentialsPath, "utf8");
    const data: CredentialsFile = JSON.parse(content);
    return parseCredentialsData(data, now);
  } catch {
    return null;
  }
}

/**
 * Parse and validate credentials data from either Keychain or file.
 */
function parseCredentialsData(
  data: CredentialsFile,
  now: number,
): { accessToken: string; subscriptionType: string } | null {
  const accessToken = data.claudeAiOauth?.accessToken;
  const subscriptionType = data.claudeAiOauth?.subscriptionType ?? "";

  if (!accessToken) {
    return null;
  }

  // Check if token is expired (expiresAt is Unix ms timestamp)
  // Use != null to handle expiresAt=0 correctly (would be expired)
  const expiresAt = data.claudeAiOauth?.expiresAt;
  if (expiresAt !== undefined && expiresAt <= now) {
    return null;
  }

  return { accessToken, subscriptionType };
}

/**
 * Read OAuth credentials, trying macOS Keychain first (Claude Code 2.x),
 * then falling back to file-based credentials (older versions).
 *
 * Token priority: Keychain token is authoritative (Claude Code 2.x stores current token there).
 * SubscriptionType: Can be supplemented from file if keychain lacks it (display-only field).
 */
function readCredentials(
  homeDir: string,
  now: number,
  readKeychain: (
    now: number,
    homeDir: string,
  ) => { accessToken: string; subscriptionType: string } | null,
): { accessToken: string; subscriptionType: string } | null {
  // Try macOS Keychain first (Claude Code 2.x)
  const keychainCreds = readKeychain(now, homeDir);
  if (keychainCreds) {
    if (keychainCreds.subscriptionType) {
      return keychainCreds;
    }
    // Keychain has token but no subscriptionType - try to supplement from file
    const fileCreds = readFileCredentials(homeDir, now);
    if (fileCreds?.subscriptionType) {
      return {
        accessToken: keychainCreds.accessToken,
        subscriptionType: fileCreds.subscriptionType,
      };
    }
    // No subscriptionType available - use keychain token anyway
    return keychainCreds;
  }

  // Fall back to file-based credentials (older versions or non-macOS)
  const fileCreds = readFileCredentials(homeDir, now);
  if (fileCreds) {
    return fileCreds;
  }

  return null;
}

function getPlanName(subscriptionType: string): string | null {
  const lower = subscriptionType.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("team")) return "Team";
  // API users don't have subscriptionType or have 'api'
  if (!subscriptionType || lower.includes("api")) return null;
  // Unknown subscription type - show it capitalized
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** Parse utilization value, clamping to 0-100 and handling NaN/Infinity */
function parseUtilization(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value)) return null; // Handles NaN and Infinity
  return Math.round(Math.max(0, Math.min(100, value)));
}

/** Parse an ISO date as Unix epoch seconds. */
function parseDate(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  // Check for Invalid Date
  if (isNaN(date.getTime())) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

function fetchUsageApi(accessToken: string): Promise<UsageApiResponse | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-hud/1.0",
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }

        try {
          const parsed: UsageApiResponse = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => {
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}
