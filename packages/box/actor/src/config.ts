export const FRAME_BYTES = 1_048_576;
export const PROMPT_QUEUE_LIMIT = 32;
export const REPLAY_LIMIT = 2_048;
export const SUBSCRIBER_BUFFER_BYTES = 1_048_576;

const LOCAL_ORIGINS = [
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://localhost",
  "https://localhost",
];

export function allowedOrigins(extra = process.env.BLITZ_ALLOWED_ORIGINS): Set<string> {
  const origins = new Set(LOCAL_ORIGINS);
  for (const value of extra?.split(",") ?? []) {
    const origin = value.trim();
    if (origin) origins.add(origin);
  }
  return origins;
}

export function originAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return allowlist.has(parsed.origin) || allowlist.has(`${parsed.protocol}//${parsed.hostname}`);
  } catch {
    return false;
  }
}
