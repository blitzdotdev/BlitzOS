import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_BOUNDARY_PROBE_EVENT,
  ERROR_BOUNDARY_PROBE_QUERY_PARAM,
  ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE,
  ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE,
  ERROR_BOUNDARY_PROBE_STORAGE_KEY,
  consumeErrorBoundaryProbe,
  shouldTriggerErrorBoundaryProbe,
} from '../src/lib/error-boundary-probe';

function storageWith(value: string | null): Pick<Storage, 'getItem' | 'removeItem'> {
  return {
    getItem: vi.fn((key: string) => (key === ERROR_BOUNDARY_PROBE_STORAGE_KEY ? value : null)),
    removeItem: vi.fn(),
  };
}

describe('error boundary probe', () => {
  it('exposes a stable browser event trigger name', () => {
    expect(ERROR_BOUNDARY_PROBE_EVENT).toBe('lody:error-boundary-probe');
  });

  it('requires both the query trigger and local opt-in', () => {
    const search = `?${ERROR_BOUNDARY_PROBE_QUERY_PARAM}=${ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE}`;

    expect(shouldTriggerErrorBoundaryProbe(search, storageWith(null))).toBe(false);
    expect(
      shouldTriggerErrorBoundaryProbe(
        '?other=1',
        storageWith(ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE)
      )
    ).toBe(false);
    expect(
      shouldTriggerErrorBoundaryProbe(
        search,
        storageWith(ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE)
      )
    ).toBe(true);
  });

  it('fails closed when storage cannot be read', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage blocked');
      }),
      removeItem: vi.fn(),
    };

    expect(
      shouldTriggerErrorBoundaryProbe(
        `?${ERROR_BOUNDARY_PROBE_QUERY_PARAM}=${ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE}`,
        storage
      )
    ).toBe(false);
  });

  it('consumes the probe before reporting that it should throw', () => {
    const storage = storageWith(ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE);
    const location = {
      pathname: '/acme',
      search: `?tab=chat&${ERROR_BOUNDARY_PROBE_QUERY_PARAM}=${ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE}`,
      hash: '#messages',
    };
    const history = {
      state: { router: true },
      replaceState: vi.fn(),
    };

    expect(consumeErrorBoundaryProbe(storage, location, history)).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(ERROR_BOUNDARY_PROBE_STORAGE_KEY);
    expect(history.replaceState).toHaveBeenCalledWith(
      { router: true },
      '',
      '/acme?tab=chat#messages'
    );
  });
});
