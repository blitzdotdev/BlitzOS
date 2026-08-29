import {
  createLocalCloudPort,
  type CloudAccessPort,
  type CloudPort,
  type CloudPortIdentity,
} from '@lody/platform';

type TestCloudPortOverrides = Omit<Partial<CloudPort>, 'access' | 'identity'> & {
  access?: Partial<CloudAccessPort>;
  identity?: Partial<CloudPortIdentity>;
};

/**
 * Explicit process-boundary fixture for CLI unit tests. Feature tests override
 * only the cloud port they exercise; every other cloud integration remains
 * absent, matching the open-source platform contract.
 */
export function createTestCloudPort(overrides: TestCloudPortOverrides = {}): CloudPort {
  const identity: CloudPortIdentity = {
    userId: 'user-1',
    ...overrides.identity,
  };
  const local = createLocalCloudPort({ identity, workspaces: [] });

  return {
    ...local,
    ...overrides,
    identity,
    access: {
      ...local.access,
      ...overrides.access,
    },
  };
}
