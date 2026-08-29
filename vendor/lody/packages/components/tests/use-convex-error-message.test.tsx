/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVEX_AUTH_ERROR_CODE, CONVEX_AUTH_ERROR_KIND } from '@lody/shared';

const mocks = vi.hoisted(() => ({ requestAuthRecovery: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ requestAuthRecovery: mocks.requestAuthRecovery }),
}));

import { useConvexErrorMessage } from '../src/hooks/use-convex-error-message';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useConvexErrorMessage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getMessage: ReturnType<typeof useConvexErrorMessage> | null;

  beforeEach(async () => {
    mocks.requestAuthRecovery.mockClear();
    getMessage = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    function Consumer() {
      getMessage = useConvexErrorMessage();
      return null;
    }
    await act(async () => root.render(<Consumer />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('recovers branded auth failures without exposing the Convex error', () => {
    const error = new ConvexError({
      kind: CONVEX_AUTH_ERROR_KIND,
      code: CONVEX_AUTH_ERROR_CODE.unauthenticated,
    });

    expect(getMessage!(error, 'fallback')).toBe(
      'Refreshing your session. Please try again in a moment.'
    );
    expect(mocks.requestAuthRecovery).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary operation errors without triggering auth recovery', () => {
    expect(getMessage!(new Error('operation failed'), 'fallback')).toBe('operation failed');
    expect(mocks.requestAuthRecovery).not.toHaveBeenCalled();
  });

  it('uses the safe fallback for non-auth Convex errors', () => {
    expect(getMessage!(new ConvexError({ code: 'conflict' }), 'safe fallback')).toBe(
      'safe fallback'
    );
    expect(
      getMessage!(
        new Error('[CONVEX A(github:refresh)] Server Error\n  Called by client'),
        'safe fallback'
      )
    ).toBe('safe fallback');
    expect(mocks.requestAuthRecovery).not.toHaveBeenCalled();
  });
});
