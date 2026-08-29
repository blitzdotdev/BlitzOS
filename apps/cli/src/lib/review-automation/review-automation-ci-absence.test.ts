import { describe, expect, it } from 'vitest';
import { NO_CI_GRACE_MS, trackCiAbsence } from './review-automation-engine';

const PR_URL = 'https://github.com/o/r/pull/1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('trackCiAbsence', () => {
  it('stamps the first sighting without confirming, and asks for a retry at the grace boundary', () => {
    const firstSeen = new Map<string, number>();
    const verdict = trackCiAbsence({
      prUrl: PR_URL,
      headSha: SHA_A,
      ciState: undefined,
      firstSeen,
      now: 10_000,
    });
    expect(verdict.noCiConfirmed).toBe(false);
    expect(verdict.retryAfterMs).toBe(NO_CI_GRACE_MS);
    expect(firstSeen.get(`${PR_URL}@${SHA_A}`)).toBe(10_000);
  });

  it('confirms once the same head has shown no rollup for the full grace window', () => {
    const firstSeen = new Map<string, number>();
    trackCiAbsence({ prUrl: PR_URL, headSha: SHA_A, ciState: undefined, firstSeen, now: 0 });
    const before = trackCiAbsence({
      prUrl: PR_URL,
      headSha: SHA_A,
      ciState: undefined,
      firstSeen,
      now: NO_CI_GRACE_MS - 1,
    });
    expect(before.noCiConfirmed).toBe(false);
    expect(before.retryAfterMs).toBe(1);
    const at = trackCiAbsence({
      prUrl: PR_URL,
      headSha: SHA_A,
      ciState: undefined,
      firstSeen,
      now: NO_CI_GRACE_MS,
    });
    expect(at).toEqual({ noCiConfirmed: true });
  });

  it('restarts the window when the head moves', () => {
    // A new push registers new check suites, so an old head's age proves
    // nothing about the new one.
    const firstSeen = new Map<string, number>();
    trackCiAbsence({ prUrl: PR_URL, headSha: SHA_A, ciState: undefined, firstSeen, now: 0 });
    const verdict = trackCiAbsence({
      prUrl: PR_URL,
      headSha: SHA_B,
      ciState: undefined,
      firstSeen,
      now: NO_CI_GRACE_MS * 2,
    });
    expect(verdict.noCiConfirmed).toBe(false);
    expect(firstSeen.has(`${PR_URL}@${SHA_A}`)).toBe(false);
    expect(firstSeen.get(`${PR_URL}@${SHA_B}`)).toBe(NO_CI_GRACE_MS * 2);
  });

  it('voids the stamp as soon as CI reports anything', () => {
    const firstSeen = new Map<string, number>();
    trackCiAbsence({ prUrl: PR_URL, headSha: SHA_A, ciState: undefined, firstSeen, now: 0 });
    const verdict = trackCiAbsence({
      prUrl: PR_URL,
      headSha: SHA_A,
      ciState: 'p',
      firstSeen,
      now: NO_CI_GRACE_MS * 2,
    });
    expect(verdict).toEqual({ noCiConfirmed: false });
    expect(firstSeen.size).toBe(0);
  });

  it('tracks nothing while the head is unknown', () => {
    const firstSeen = new Map<string, number>();
    const verdict = trackCiAbsence({
      prUrl: PR_URL,
      headSha: undefined,
      ciState: undefined,
      firstSeen,
      now: 0,
    });
    expect(verdict).toEqual({ noCiConfirmed: false });
    expect(firstSeen.size).toBe(0);
  });
});
