import { describe, expect, it } from 'vitest';
import { buildMissingEmail } from '@lody/shared';

import {
  buildGitHubNoreplyEmail,
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  DEFAULT_AI_GIT_AUTHOR_NAME,
  resolveSessionGitIdentity,
} from '../src/session/git-identity';

describe('resolveSessionGitIdentity', () => {
  it('uses the requested identity when the requested email is real', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { name: 'Local User', email: 'local@example.com' }
      )
    ).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
    });
  });

  it('uses the host git identity when the requested email is a missing-email placeholder', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        { name: 'Local User', email: 'local@example.com' }
      )
    ).toEqual({
      name: 'Local User',
      email: 'local@example.com',
    });
  });

  it('falls back to the LodyAI identity when neither requested nor host email is usable', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        {}
      )
    ).toEqual({
      name: DEFAULT_AI_GIT_AUTHOR_NAME,
      email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
    });
  });

  it('keeps a GitHub no-reply commit email over the host identity', () => {
    const noreply = buildGitHubNoreplyEmail('4324', 'ada');
    expect(
      resolveSessionGitIdentity({ name: 'Ada', email: noreply }, { email: 'local@example.com' })
    ).toEqual({
      name: 'Ada',
      email: '4324+ada@users.noreply.github.com',
    });
  });
});

describe('buildGitHubNoreplyEmail', () => {
  it('builds the canonical id+login attribution address', () => {
    expect(buildGitHubNoreplyEmail('1234567', 'ada')).toBe(
      '1234567+ada@users.noreply.github.com'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(buildGitHubNoreplyEmail(' 1234567 ', ' ada ')).toBe(
      '1234567+ada@users.noreply.github.com'
    );
  });

  it('returns undefined without both a numeric account id and a login', () => {
    expect(buildGitHubNoreplyEmail('1234567', undefined)).toBeUndefined();
    expect(buildGitHubNoreplyEmail(undefined, 'ada')).toBeUndefined();
    expect(buildGitHubNoreplyEmail('', 'ada')).toBeUndefined();
    // A non-numeric id is not a GitHub account id; the address would not attribute.
    expect(buildGitHubNoreplyEmail('not-an-id', 'ada')).toBeUndefined();
  });
});
