export type RateLimitWindow = {
  /** Normalized percentage in the inclusive 0..100 range. */
  usedPercent: number;
  windowDurationSeconds: number | null;
  resetsAtEpochSeconds: number | null;
};

export type RateLimitWallet = {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
};

export type RateLimitScope = {
  providerId: string;
  accountId?: string;
  modelId?: string;
};

export type RateLimit = {
  limitId: string;
  scope: RateLimitScope;
  limitName?: string | null;
  planName?: string | null;
  windows: RateLimitWindow[];
  wallet?: RateLimitWallet | null;
};

export type RateLimitsSnapshot = {
  rateLimits: RateLimit[];
  fetchedAtEpochSeconds?: number;
};

export type RateLimitsGetRequest = {
  sessionId?: string;
  accountId?: string;
  modelId?: string;
};

export type RateLimitsGetResponse = RateLimitsSnapshot;
export type RateLimitsUpdate = RateLimitsSnapshot;
