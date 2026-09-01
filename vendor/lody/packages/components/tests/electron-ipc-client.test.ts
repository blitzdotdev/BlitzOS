// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createLodyIpcProxy, getIpcServices } from '../src/lib/electron-ipc-client';

describe('createLodyIpcProxy invoke shape', () => {
  it('calls invoke with group.method', async () => {
    const invoke = vi.fn().mockResolvedValue({ userId: 'local:1' });
    const services = createLodyIpcProxy({ invoke })!;
    await services.localPlatform.getSnapshot();
    expect(invoke).toHaveBeenCalledWith('localPlatform.getSnapshot');
  });

  it('returns null when the bridge is missing', () => {
    expect(createLodyIpcProxy(null)).toBeNull();
    expect(createLodyIpcProxy(undefined)).toBeNull();
  });

  it('reads window.ipc after the module has loaded', async () => {
    const invoke = vi.fn().mockResolvedValue({ userId: 'local:1' });
    window.ipc = {
      invoke,
      on: () => () => {},
      send: () => {},
    };
    const services = getIpcServices();
    await services!.localPlatform.getSnapshot();
    expect(invoke).toHaveBeenCalledWith('localPlatform.getSnapshot');
    delete window.ipc;
    expect(getIpcServices()).toBeNull();
  });
});
