import { describe, expect, it } from 'vitest';
import { readDesktopMachinePairingRequestId } from '../src/lib/desktop-machine-pairing-deep-link';

describe('desktop machine pairing deep links', () => {
  it('reads only the non-secret request id', () => {
    expect(readDesktopMachinePairingRequestId('lody://machine/connect?requestId=request-123')).toBe(
      'request-123'
    );
  });

  it('rejects unrelated lody links', () => {
    expect(readDesktopMachinePairingRequestId('lody://auth/callback?requestId=request-123')).toBe(
      null
    );
  });
});
