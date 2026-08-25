import { describe, expect, it } from 'vitest';
import { parseRepoUrlLines } from '../src/files/repo-urls.js';

describe('repository URL lines', () => {
  it.each([
    ['owner/name', 'owner/name'],
    ['github.com/owner/name', 'owner/name'],
    ['WWW.GITHUB.COM/owner/name', 'owner/name'],
    ['https://GITHUB.COM/owner/name', 'owner/name'],
    ['http://github.com/owner/name', 'owner/name'],
    ['git@GITHUB.COM:owner/name', 'owner/name'],
    ['ssh://git@github.com/owner/name', 'owner/name'],
  ])('accepts %s', (input, repo) => {
    expect(parseRepoUrlLines(input)).toEqual([{ raw: input, repo, problem: null }]);
  });

  it.each([
    ['owner/name.git', 'owner/name'],
    ['owner/name/', 'owner/name'],
    ['https://github.com/owner/name.git/', 'owner/name'],
  ])('strips clone suffixes from %s', (input, repo) => {
    expect(parseRepoUrlLines(input)).toEqual([{ raw: input, repo, problem: null }]);
  });

  it('drops blank lines and trims the lines it keeps', () => {
    expect(parseRepoUrlLines('\n  owner/one  \r\n\t\nowner/two\n')).toEqual([
      { raw: 'owner/one', repo: 'owner/one', problem: null },
      { raw: 'owner/two', repo: 'owner/two', problem: null },
    ]);
  });

  it.each([
    [
      'https://gitlab.com/owner/name',
      'only github.com repositories can be cloned',
    ],
    [
      'https://github.com/owner/name/issues',
      'drop the path after the repository name',
    ],
    ['not a repository', 'not a repository URL'],
  ])('rejects %s with the matching problem', (input, problem) => {
    expect(parseRepoUrlLines(input)).toEqual([{ raw: input, repo: null, problem }]);
  });
});
