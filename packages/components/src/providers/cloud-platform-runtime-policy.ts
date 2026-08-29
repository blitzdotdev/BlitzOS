import type { PlatformSyncMode } from '@lody/platform';

export type CloudPlatformRuntimePolicy = {
  ready: boolean;
  syncMode: PlatformSyncMode;
};

export function resolveCloudPlatformRuntimePolicy(options: {
  electron: boolean;
  localAgentEnabled: boolean | null;
}): CloudPlatformRuntimePolicy {
  if (!options.electron) {
    return { ready: true, syncMode: 'cloud' };
  }
  if (options.localAgentEnabled === null) {
    return { ready: false, syncMode: 'dual' };
  }
  if (options.localAgentEnabled) {
    return { ready: true, syncMode: 'dual' };
  }
  return { ready: true, syncMode: 'cloud' };
}
