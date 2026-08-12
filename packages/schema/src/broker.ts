export const FEED_MAX_BYTES = 1_048_576;

export const HARNESSES = ["claude", "codex"] as const;

export interface FeedResponse {
  /** Opaque. */
  version: string;
  members: FeedMember[];
}

export interface FeedMember {
  unixName: string;
  harnesses: string[];
  /** Empty keeps the account; absence from the feed deprovisions it. */
  keys: FeedKey[];
}

export interface FeedKey {
  pubkey: string;
  op: "mint" | "deposit";
}
