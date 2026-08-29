import { resolvePlatformKind, type PlatformCapability, type PlatformKind } from '@lody/platform';
import { usePlatform } from '@lody/platform/react';

/**
 * The single build-time platform probe for GUI apps
 * (specs/platform-providers.md). Boot wiring (root providers, route gating,
 * runtime assembly) may branch on this; feature UI must consume capabilities
 * via the platform context instead of asking "which build is this".
 *
 * `resolvePlatformKind` throws on an unrecognized value — a build that asked
 * for `local` must never silently run the cloud platform.
 */
let cachedKind: PlatformKind | null = null;

export function getAppPlatformKind(): PlatformKind {
  if (cachedKind === null) {
    cachedKind = resolvePlatformKind(import.meta.env.VITE_LODY_PLATFORM);
  }
  return cachedKind;
}

export function isLocalAppPlatform(): boolean {
  return getAppPlatformKind() === 'local';
}

/**
 * Capability check for feature UI. Every app assembly must mount a complete
 * PlatformProvider; a missing provider is a programming error rather than an
 * implicit cloud fallback.
 */
export function useAppCapabilityCheck(): (capability: PlatformCapability) => boolean {
  const platform = usePlatform();
  return (capability) => platform.capabilities.has(capability);
}

export function useAppCapability(capability: PlatformCapability): boolean {
  return useAppCapabilityCheck()(capability);
}
