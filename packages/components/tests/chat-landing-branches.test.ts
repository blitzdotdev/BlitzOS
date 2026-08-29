import { describe, expect, it } from 'vitest';
import {
  areChatLandingBranchListsEqual,
  createChatLandingBranchSnapshot,
  getGitHubBranchesCacheId,
  resolveChatLandingBranchSelection,
} from '../src/lib/chat-landing-branches';

describe('chat landing branches', () => {
  it('normalizes branch snapshots and keeps the default branch available', () => {
    expect(
      createChatLandingBranchSnapshot([' feature ', '', 'main', 'feature'], ' develop ')
    ).toEqual({
      branches: ['develop', 'feature', 'main'],
      defaultBranch: 'develop',
    });
  });

  it('preserves the current branch when refreshed branches still include it', () => {
    const snapshot = createChatLandingBranchSnapshot(['main', 'release'], 'main');

    expect(resolveChatLandingBranchSelection(snapshot, 'release')).toBe('release');
  });

  it('falls back to a preferred available branch and clears selection for empty repositories', () => {
    expect(
      resolveChatLandingBranchSelection(
        createChatLandingBranchSnapshot(['release'], 'release'),
        'deleted'
      )
    ).toBe('release');
    expect(
      resolveChatLandingBranchSelection(createChatLandingBranchSnapshot([], null), 'main')
    ).toBeNull();
  });

  it('compares normalized branch lists and namespaces branch cache entries by workspace', () => {
    expect(areChatLandingBranchListsEqual(['main'], ['main'])).toBe(true);
    expect(areChatLandingBranchListsEqual(['main'], ['main', 'release'])).toBe(false);
    expect(getGitHubBranchesCacheId('workspace-a', 'owner/repo')).toBe('workspace-a:owner/repo');
  });
});
