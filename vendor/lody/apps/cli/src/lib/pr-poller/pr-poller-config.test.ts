import { describe, expect, it } from 'vitest';
import { loadPrPollerConfig, PR_POLLER_DEFAULTS } from './pr-poller-config';

describe('loadPrPollerConfig', () => {
  it('returns spec defaults when no env is set', () => {
    const config = loadPrPollerConfig({});

    expect(config.enabled).toBe(true);
    expect(config.highIntervalMs).toBe(20_000);
    expect(config.lowStatusIntervalMs).toBe(5 * 60_000);
    expect(config.lowDiscoveryIntervalMs).toBe(20 * 60_000);
    expect(config.lowMinIntervalMs).toBe(60_000);
    expect(config.activityWindowMs).toBe(10 * 60_000);
    expect(config.highOwnerCap).toBe(100);
    expect(config.lowLaneEveryNBatches).toBe(5);
    expect(config.bucketCapacityPoints).toBe(20);
    expect(config.bucketRefillPointsPerMinute).toBe(4);
    expect(config.maxAliasesPerQuery).toBe(20);
    expect(config.fetchTimeoutMs).toBe(30_000);
    expect(config.fetchConcurrency).toBe(2);
    expect(config.repoCooldownBaseMs).toBe(15 * 60_000);
    expect(config.repoCooldownMaxMs).toBe(2 * 60 * 60_000);
    expect(config.rateLimitFreezeRemainingRatio).toBe(0.1);
  });

  it('LODY_PR_POLL_DISABLED=1 is the kill switch', () => {
    expect(loadPrPollerConfig({ LODY_PR_POLL_DISABLED: '1' }).enabled).toBe(false);
    expect(loadPrPollerConfig({ LODY_PR_POLL_DISABLED: 'true' }).enabled).toBe(false);
    expect(loadPrPollerConfig({ LODY_PR_POLL_DISABLED: '0' }).enabled).toBe(true);
    expect(loadPrPollerConfig({ LODY_PR_POLL_DISABLED: 'yes' }).enabled).toBe(true);
  });

  it('applies cadence and budget overrides', () => {
    const config = loadPrPollerConfig({
      LODY_PR_POLL_HIGH_INTERVAL_MS: '30000',
      LODY_PR_POLL_LOW_STATUS_INTERVAL_MS: '120000',
      LODY_PR_POLL_LOW_DISCOVERY_INTERVAL_MS: '600000',
      LODY_PR_POLL_LOW_MIN_INTERVAL_MS: '45000',
      LODY_PR_POLL_ACTIVITY_WINDOW_MS: '300000',
      LODY_PR_POLL_HIGH_OWNER_CAP: '50',
      LODY_PR_POLL_LOW_LANE_EVERY_N: '4',
      LODY_PR_POLL_BUCKET_CAPACITY: '50',
      LODY_PR_POLL_BUCKET_REFILL_PER_MINUTE: '10',
      LODY_PR_POLL_MAX_ALIASES: '10',
      LODY_PR_POLL_FETCH_TIMEOUT_MS: '5000',
      LODY_PR_POLL_FETCH_CONCURRENCY: '3',
    });

    expect(config.highIntervalMs).toBe(30_000);
    expect(config.lowStatusIntervalMs).toBe(120_000);
    expect(config.lowDiscoveryIntervalMs).toBe(600_000);
    expect(config.lowMinIntervalMs).toBe(45_000);
    expect(config.activityWindowMs).toBe(300_000);
    expect(config.highOwnerCap).toBe(50);
    expect(config.lowLaneEveryNBatches).toBe(4);
    expect(config.bucketCapacityPoints).toBe(50);
    expect(config.bucketRefillPointsPerMinute).toBe(10);
    expect(config.maxAliasesPerQuery).toBe(10);
    expect(config.fetchTimeoutMs).toBe(5_000);
    expect(config.fetchConcurrency).toBe(3);
  });

  it('falls back to defaults for unparseable or non-positive values', () => {
    const config = loadPrPollerConfig({
      LODY_PR_POLL_HIGH_INTERVAL_MS: 'abc',
      LODY_PR_POLL_BUCKET_CAPACITY: '-5',
      LODY_PR_POLL_FETCH_CONCURRENCY: '0',
      LODY_PR_POLL_LOW_STATUS_INTERVAL_MS: '',
    });

    expect(config.highIntervalMs).toBe(PR_POLLER_DEFAULTS.highIntervalMs);
    expect(config.bucketCapacityPoints).toBe(PR_POLLER_DEFAULTS.bucketCapacityPoints);
    expect(config.fetchConcurrency).toBe(PR_POLLER_DEFAULTS.fetchConcurrency);
    expect(config.lowStatusIntervalMs).toBe(PR_POLLER_DEFAULTS.lowStatusIntervalMs);
  });
});
