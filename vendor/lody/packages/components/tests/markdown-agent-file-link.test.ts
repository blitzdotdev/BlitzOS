import { describe, expect, it } from 'vitest';
import {
  isMarkdownAgentFileHref,
  normalizeMarkdownAgentFilePath,
  parseMarkdownAgentFileHref,
} from '../src/lib/markdown-agent-file-link';

describe('isMarkdownAgentFileHref', () => {
  it('treats slash-prefixed markdown hrefs as agent file references', () => {
    expect(isMarkdownAgentFileHref('/home/agent/project/src/app.ts')).toBe(true);
    expect(isMarkdownAgentFileHref('\\Users\\agent\\project\\src\\app.ts')).toBe(true);
  });

  it('treats repo-relative file references as agent file links', () => {
    expect(isMarkdownAgentFileHref('README.md')).toBe(true);
    expect(isMarkdownAgentFileHref('README.md#L100')).toBe(true);
    expect(isMarkdownAgentFileHref('README.md:100')).toBe(true);
    expect(isMarkdownAgentFileHref('README.md:L100')).toBe(true);
    expect(isMarkdownAgentFileHref('README.md:L100C12')).toBe(true);
    expect(isMarkdownAgentFileHref('./docs/README.md:100')).toBe(true);
  });

  it('leaves web and fragment hrefs as ordinary links', () => {
    expect(isMarkdownAgentFileHref('https://example.com/docs')).toBe(false);
    expect(isMarkdownAgentFileHref('mailto:test@example.com')).toBe(false);
    expect(isMarkdownAgentFileHref('#README')).toBe(false);
    expect(isMarkdownAgentFileHref('README.md#readme')).toBe(false);
    expect(isMarkdownAgentFileHref('//cdn.example.com/app.js')).toBe(false);
    expect(isMarkdownAgentFileHref(undefined)).toBe(false);
  });

  it('recognizes backslash UNC paths without treating protocol-relative URLs as files', () => {
    expect(isMarkdownAgentFileHref('\\\\server\\share\\repo\\README.md')).toBe(true);
    expect(isMarkdownAgentFileHref('//cdn.example.com/app.js')).toBe(false);
  });
});

describe('parseMarkdownAgentFileHref', () => {
  it('extracts a GitHub-style line suffix without changing the file path', () => {
    expect(parseMarkdownAgentFileHref('README.md#L100')).toEqual({
      filePath: 'README.md',
      startLine: 100,
      endLine: undefined,
      lineSuffixFormat: 'github',
    });
  });

  it('extracts a colon-style line suffix without treating it as the file extension', () => {
    expect(parseMarkdownAgentFileHref('README.md:100')).toEqual({
      filePath: 'README.md',
      startLine: 100,
      endLine: undefined,
      lineSuffixFormat: 'colon',
    });
  });

  it('extracts VS Code-style line and column suffixes without treating them as the file path', () => {
    expect(parseMarkdownAgentFileHref('packages/slate/src/transforms/index.ts:L6')).toEqual({
      filePath: 'packages/slate/src/transforms/index.ts',
      startLine: 6,
      endLine: undefined,
      lineSuffixFormat: 'vscode',
    });

    expect(parseMarkdownAgentFileHref('packages/slate/src/transforms/index.ts:L6C10')).toEqual({
      filePath: 'packages/slate/src/transforms/index.ts',
      startLine: 6,
      startColumn: 10,
      endLine: undefined,
      lineSuffixFormat: 'vscode',
    });
  });

  it('extracts GitHub-style column suffixes when present', () => {
    expect(parseMarkdownAgentFileHref('packages/slate/src/transforms/index.ts#L6C10')).toEqual({
      filePath: 'packages/slate/src/transforms/index.ts',
      startLine: 6,
      startColumn: 10,
      endLine: undefined,
      lineSuffixFormat: 'github',
    });
  });

  it('supports line ranges for both suffix styles', () => {
    expect(parseMarkdownAgentFileHref('README.md#L100-L110')).toEqual({
      filePath: 'README.md',
      startLine: 100,
      endLine: 110,
      lineSuffixFormat: 'github',
    });

    expect(parseMarkdownAgentFileHref('README.md:100:110')).toEqual({
      filePath: 'README.md',
      startLine: 100,
      endLine: 110,
      lineSuffixFormat: 'colon',
    });
  });
});

describe('normalizeMarkdownAgentFilePath', () => {
  it('converts a local-project absolute href to a project-relative file path', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        '/home/agent/project/packages/components/src/index.ts',
        '/home/agent/project'
      )
    ).toBe('packages/components/src/index.ts');
  });

  it('normalizes backslashes before stripping the local project root', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        '\\home\\agent\\project\\packages\\components\\src\\index.ts',
        '/home/agent/project/'
      )
    ).toBe('packages/components/src/index.ts');
  });

  it('matches Windows drive paths case-insensitively', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        'C:\\Users\\Agent\\Repo\\packages\\components\\src\\index.ts',
        'c:\\users\\agent\\repo'
      )
    ).toBe('packages/components/src/index.ts');
  });

  it('matches Windows UNC roots case-insensitively', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        '\\\\SERVER\\Share\\Repo\\packages\\components\\src\\index.ts',
        '\\\\server\\share\\repo'
      )
    ).toBe('packages/components/src/index.ts');
  });

  it('decodes URL-encoded path segments exactly once', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        '/home/agent/project/docs/My%20File%2520Name.md',
        '/home/agent/project'
      )
    ).toBe('docs/My File%20Name.md');
  });

  it('preserves malformed URL encoding instead of throwing', () => {
    expect(
      normalizeMarkdownAgentFilePath('/home/agent/project/docs/100%.md', '/home/agent/project')
    ).toBe('docs/100%.md');
  });

  it('converts a lody worktree href to a worktree-relative file path', () => {
    expect(
      normalizeMarkdownAgentFilePath(
        '/home/agent/.lody/repos/github---example---project/worktrees/5110aa94-b18b-43cf-afa7-369905c2515a/packages/components/src/index.ts'
      )
    ).toBe('packages/components/src/index.ts');
  });

  it('preserves a slash-prefixed path when there is no matching local root or worktree', () => {
    expect(normalizeMarkdownAgentFilePath('/var/tmp/output.txt', '/home/agent/project')).toBe(
      '/var/tmp/output.txt'
    );
  });

  it('preserves GitHub-style line suffixes while stripping the local project root', () => {
    expect(
      normalizeMarkdownAgentFilePath('/home/agent/project/README.md#L100', '/home/agent/project')
    ).toBe('README.md#L100');
  });

  it('preserves colon-style line suffixes while stripping the local project root', () => {
    expect(
      normalizeMarkdownAgentFilePath('/home/agent/project/README.md:100', '/home/agent/project')
    ).toBe('README.md:100');
  });

  it('preserves VS Code-style line suffixes while stripping the local project root', () => {
    expect(
      normalizeMarkdownAgentFilePath('/home/agent/project/README.md:L100C12', '/home/agent/project')
    ).toBe('README.md:L100C12');
  });
});
