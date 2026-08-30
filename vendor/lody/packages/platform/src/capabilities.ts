/**
 * Cloud-backed product capabilities.
 *
 * UI and CLI features render/enable themselves by asking `capabilities.has(...)`,
 * never by asking "is Convex configured" or "which build is this". The local
 * (open-source) platform exposes an empty set; the cloud platform exposes all of
 * them (some may later become plan-dependent).
 */
export const PLATFORM_CAPABILITIES = [
  /** Multi-device sync over Loro Streams. */
  'cloudSync',
  /** Account UI: login, logout, profile, device pairing. */
  'cloudAccount',
  /** Workspace switcher / creation / management UI. */
  'multiWorkspace',
  /** Billing, subscription and checkout surfaces. */
  'billing',
  /** Cloud-aggregated token and cost reporting. */
  'usageAnalytics',
  /** Sharing sessions/machines/projects with workspace members. */
  'teamSharing',
  /** GitHub App integration (repo registry, brokered tokens, PR status). */
  'githubIntegration',
  /** Dispatching work to machines other than the local one. */
  'remoteMachines',
  /** Push notifications / live activity. */
  'notifications',
  /** In-app bug report upload. */
  'bugReport',
  /** Shareable remote preview tunnels (local loopback preview is always available). */
  'remotePreview',
  /** Product analytics / crash reporting. */
  'telemetry',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export interface PlatformCapabilities {
  has(capability: PlatformCapability): boolean;
  list(): readonly PlatformCapability[];
}

export function createCapabilitySet(
  capabilities: Iterable<PlatformCapability>
): PlatformCapabilities {
  const set = new Set(capabilities);
  const frozen = Object.freeze([...set]);
  return {
    has: (capability) => set.has(capability),
    list: () => frozen,
  };
}

/** The open-source local platform: no cloud-backed capability is available. */
export const LOCAL_PLATFORM_CAPABILITIES: PlatformCapabilities = createCapabilitySet([]);

/** The cloud platform baseline: every capability (entitlement gating happens elsewhere). */
export const CLOUD_PLATFORM_CAPABILITIES: PlatformCapabilities =
  createCapabilitySet(PLATFORM_CAPABILITIES);
