export interface GitignoreRule {
  readonly basePath: string;
  readonly directoryOnly: boolean;
  readonly hasSlash: boolean;
  readonly negated: boolean;
  readonly pattern: string;
  readonly regex: RegExp;
}

export function parseGitignoreRules(text: string, basePath: string): readonly GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const parsed = parseGitignoreLine(rawLine);
    if (!parsed) continue;
    rules.push({
      basePath,
      directoryOnly: parsed.directoryOnly,
      hasSlash: parsed.hasSlash,
      negated: parsed.negated,
      pattern: parsed.pattern,
      regex: gitignorePatternRegExp(parsed.pattern, parsed.hasSlash),
    });
  }
  return rules;
}

export function isIgnoredByGitignoreRules(
  relativePath: string,
  isDirectory: boolean,
  rules: readonly GitignoreRule[]
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (!gitignoreRuleMatches(rule, relativePath, isDirectory)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

function parseGitignoreLine(rawLine: string):
  | {
      readonly directoryOnly: boolean;
      readonly hasSlash: boolean;
      readonly negated: boolean;
      readonly pattern: string;
    }
  | undefined {
  let line = trimUnescapedTrailingSpaces(rawLine);
  if (line === '') return undefined;
  if (line.startsWith('#')) return undefined;
  const escapedLeadingMarker = line.startsWith('\\#') || line.startsWith('\\!');
  if (escapedLeadingMarker) {
    line = line.slice(1);
  }

  let negated = false;
  if (!escapedLeadingMarker && line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  if (line === '') return undefined;

  const directoryOnly = line.endsWith('/');
  if (directoryOnly) line = line.slice(0, -1);
  const anchored = line.startsWith('/');
  while (line.startsWith('/')) line = line.slice(1);
  if (line === '') return undefined;

  return {
    directoryOnly,
    hasSlash: anchored || line.includes('/'),
    negated,
    pattern: line,
  };
}

function trimUnescapedTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ' ' && !isEscaped(value, end - 1)) {
    end -= 1;
  }
  return value.slice(0, end).replace(/\\ /gu, ' ');
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function gitignorePatternRegExp(pattern: string, hasSlash: boolean): RegExp {
  const source = globToRegExpSource(pattern);
  return new RegExp(hasSlash ? `^${source}(?:/.*)?$` : `^${source}$`, 'u');
}

function globToRegExpSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      const after = pattern[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '\\') {
      const escaped = pattern[index + 1];
      if (escaped !== undefined) {
        source += escapeRegExp(escaped);
        index += 1;
      } else {
        source += '\\\\';
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
}

function gitignoreRuleMatches(
  rule: GitignoreRule,
  relativePath: string,
  isDirectory: boolean
): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const localPath = localPathForRule(rule.basePath, relativePath);
  if (localPath === undefined || localPath === '') return false;
  if (rule.hasSlash) return rule.regex.test(localPath);
  return localPath.split('/').some((segment) => rule.regex.test(segment));
}

function localPathForRule(basePath: string, relativePath: string): string | undefined {
  if (basePath === '') return relativePath;
  if (relativePath === basePath) return '';
  const prefix = `${basePath}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}
