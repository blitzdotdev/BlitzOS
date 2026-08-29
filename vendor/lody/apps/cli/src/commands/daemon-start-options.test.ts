import { describe, expect, it } from 'vitest';
import { buildDaemonStartPassthroughArgs } from './daemon-start-options';

describe('buildDaemonStartPassthroughArgs', () => {
  it('never forwards auth credentials to the daemon runner', () => {
    expect(
      buildDaemonStartPassthroughArgs({ auth: 'lody_pair_secret', machineName: 'build-host' }, [
        '--debug',
        '--auth',
        'fallback-secret',
        '--auth=inline-secret',
      ])
    ).toEqual(['--machine-name', 'build-host', '--debug']);
  });
});
