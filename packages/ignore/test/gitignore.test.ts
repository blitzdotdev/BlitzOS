import { describe, expect, it } from 'vitest';
import { isIgnoredByGitignoreRules, parseGitignoreRules } from '../src/index';

describe('gitignore fallback pure matcher', () => {
  it('parses comments, escaped leading markers, escaped spaces, negation, and directory-only rules', () => {
    const rules = parseGitignoreRules(
      [
        '# comment',
        '',
        '*.log   ',
        'name\\ with\\ spaces.txt ',
        '\\#literal',
        '\\!literal',
        '!keep.log',
        'build/',
      ].join('\n'),
      ''
    );

    expect(
      rules.map((rule) => ({
        directoryOnly: rule.directoryOnly,
        hasSlash: rule.hasSlash,
        negated: rule.negated,
        pattern: rule.pattern,
      }))
    ).toEqual([
      { directoryOnly: false, hasSlash: false, negated: false, pattern: '*.log' },
      { directoryOnly: false, hasSlash: false, negated: false, pattern: 'name with spaces.txt' },
      { directoryOnly: false, hasSlash: false, negated: false, pattern: '#literal' },
      { directoryOnly: false, hasSlash: false, negated: false, pattern: '!literal' },
      { directoryOnly: false, hasSlash: false, negated: true, pattern: 'keep.log' },
      { directoryOnly: true, hasSlash: false, negated: false, pattern: 'build' },
    ]);
  });

  it('matches basename patterns at any depth and lets later negation rules win', () => {
    const rules = parseGitignoreRules(['*.log', '!keep.log', 'keep.log.bak'].join('\n'), '');

    expect(isIgnoredByGitignoreRules('debug.log', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('nested/debug.log', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('keep.log', false, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('nested/keep.log', false, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('keep.log.bak', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('debug.log.bak', false, rules)).toBe(false);
  });

  it('treats leading slash patterns as anchored to the rule base path', () => {
    const rootRules = parseGitignoreRules(['/dist/', '/root-only.txt', 'cache/'].join('\n'), '');

    expect(rootRules.map((rule) => [rule.pattern, rule.hasSlash])).toEqual([
      ['dist', true],
      ['root-only.txt', true],
      ['cache', false],
    ]);
    expect(isIgnoredByGitignoreRules('dist', true, rootRules)).toBe(true);
    expect(isIgnoredByGitignoreRules('src/dist', true, rootRules)).toBe(false);
    expect(isIgnoredByGitignoreRules('root-only.txt', false, rootRules)).toBe(true);
    expect(isIgnoredByGitignoreRules('src/root-only.txt', false, rootRules)).toBe(false);
    expect(isIgnoredByGitignoreRules('src/cache', true, rootRules)).toBe(true);
  });

  it('applies nested .gitignore rules only under their base path', () => {
    const rootRules = parseGitignoreRules('*.tmp\n', '');
    const nestedRules = parseGitignoreRules('/dist/\n*.gen.ts\n', 'packages/app');
    const rules = [...rootRules, ...nestedRules];

    expect(isIgnoredByGitignoreRules('packages/app/dist', true, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('packages/app/src/dist', true, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('packages/app/src/view.gen.ts', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('packages/other/src/view.gen.ts', false, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('packages/other/debug.tmp', false, rules)).toBe(true);
  });

  it('supports slash patterns, question marks, globstar, and escaped glob characters', () => {
    const rules = parseGitignoreRules(
      ['src/*.tmp', 'docs/??-intro.md', '**/generated/*.ts', 'literal\\*.txt'].join('\n'),
      ''
    );

    expect(isIgnoredByGitignoreRules('src/a.tmp', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('src/nested/a.tmp', false, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('docs/01-intro.md', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('docs/001-intro.md', false, rules)).toBe(false);
    expect(isIgnoredByGitignoreRules('generated/a.ts', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('src/generated/a.ts', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('literal*.txt', false, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('literal-a.txt', false, rules)).toBe(false);
  });

  it('only matches directory-only rules for directories', () => {
    const rules = parseGitignoreRules('build/\n', '');

    expect(isIgnoredByGitignoreRules('build', true, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('src/build', true, rules)).toBe(true);
    expect(isIgnoredByGitignoreRules('build', false, rules)).toBe(false);
  });
});
