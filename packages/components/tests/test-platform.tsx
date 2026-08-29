import type { ReactNode } from 'react';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { cloudPlatformApi } from '../src/providers/cloud-platform-api';

/**
 * Explicit cloud composition root for component and hook tests.
 *
 * The production PlatformContext intentionally has no default. Tests that
 * exercise cloud-backed UI should mount this provider so a missing app-level
 * platform assembly remains a fail-fast programming error.
 */
export const TEST_CLOUD_PLATFORM: PlatformProvider = {
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: async () => {},
  },
  workspaces: {
    state: createStaticStore({
      status: 'ready',
      workspaces: [],
      activeWorkspaceId: null,
    }),
    setActive: async () => {},
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: cloudPlatformApi,
  sync: { mode: 'cloud' },
};

export function TestCloudPlatformProvider({ children }: { children: ReactNode }) {
  return (
    <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>{children}</PlatformContext.Provider>
  );
}
