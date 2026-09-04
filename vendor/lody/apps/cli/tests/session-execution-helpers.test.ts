import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPrompt } from '../src/session/session-execution-helpers';

describe('session execution prompt helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces detailed Lody MCP guidance with a concise reminder', () => {
    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe(
      'inspect the UI\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.'
    );
    expect(prompt).not.toContain('lody_upload_images');
    expect(prompt).not.toContain('lody_session_create');
  });

  it('keeps GitHub worktree instructions without detailed Lody MCP guidance', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain('Name branches based on the task content');
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('The "lody" MCP server provides tools');
    expect(prompt).not.toContain('lody_upload_images');
  });

  it('omits the Lody MCP reminder when the built-in server is disabled', () => {
    vi.stubEnv('LODY_MCP_BUILTIN_DISABLED', '1');

    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe('inspect the UI');
    expect(prompt).not.toContain('Lody MCP');
  });
});
