export type FileChangeCategory = 'code' | 'doc' | 'test' | 'dev';

export type FileChangeLineDelta = {
  add: number;
  del: number;
};

export type FileChangeLike = FileChangeLineDelta & {
  filePath: string;
};

export type FileChangeCategoryGroup<T extends FileChangeLike> = FileChangeLineDelta & {
  category: FileChangeCategory;
  entries: T[];
};

export type LineChangeScope = 'all' | 'code';

type SessionDiffStatsLike = {
  allChange?: {
    add?: unknown;
    del?: unknown;
  };
};

export const FILE_CHANGE_CATEGORY_ORDER: readonly FileChangeCategory[] = [
  'code',
  'doc',
  'test',
  'dev',
];

const DOC_EXTENSIONS = new Set(['.adoc', '.markdown', '.md', '.mdx', '.rst']);
const DOC_FILE_NAMES = new Set([
  'authors',
  'changelog',
  'code_of_conduct',
  'contributing',
  'license',
  'notice',
  'readme',
  'security',
]);
const DOC_SEGMENTS = new Set(['doc', 'docs', 'documentation']);

const TEST_SEGMENTS = new Set(['__test__', '__tests__', 'spec', 'test', 'tests']);

const DEV_SEGMENTS = new Set([
  '.circleci',
  '.github',
  '.husky',
  '.idea',
  '.vscode',
  'node_modules',
]);
const DEV_FILE_NAMES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'docker-compose.yml',
  'docker-compose.yaml',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const DEV_FILE_PREFIXES = ['.env', '.eslint', '.prettier'];
const DEV_FILE_SUFFIXES = [
  '.config.cjs',
  '.config.cts',
  '.config.js',
  '.config.json',
  '.config.mjs',
  '.config.mts',
  '.config.ts',
  '.config.yaml',
  '.config.yml',
  'config.cjs',
  'config.cts',
  'config.js',
  'config.mjs',
  'config.mts',
  'config.ts',
];

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function getPathSegments(filePath: string): string[] {
  return normalizePath(filePath)
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function getFileNameWithoutKnownCompoundExtensions(fileName: string): string {
  if (/\.d\.ts$/i.test(fileName)) {
    return fileName.replace(/\.d\.ts$/i, '');
  }
  if (/\.[cm]?[jt]sx?$/i.test(fileName)) {
    return fileName.replace(/\.[cm]?[jt]sx?$/i, '');
  }
  return fileName.replace(/\.[^.]+$/i, '');
}

function getExtension(fileName: string): string {
  const match = fileName.match(/(\.[^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isDocPath(fileName: string, segments: string[]): boolean {
  const extension = getExtension(fileName);
  if (DOC_EXTENSIONS.has(extension)) {
    return true;
  }

  const fileNameWithoutExtension = getFileNameWithoutKnownCompoundExtensions(fileName);
  if (DOC_FILE_NAMES.has(fileNameWithoutExtension)) {
    return true;
  }

  return segments.some((segment) => DOC_SEGMENTS.has(segment));
}

function isTestPath(fileName: string, segments: string[]): boolean {
  if (segments.some((segment) => TEST_SEGMENTS.has(segment))) {
    return true;
  }

  const fileNameWithoutExtension = getFileNameWithoutKnownCompoundExtensions(fileName);
  return (
    /\.(test|spec)$/i.test(fileNameWithoutExtension) ||
    /^test[-_]/i.test(fileNameWithoutExtension) ||
    /[-_]test$/i.test(fileNameWithoutExtension)
  );
}

function isDevPath(filePath: string, fileName: string, segments: string[]): boolean {
  if (segments.some((segment) => DEV_SEGMENTS.has(segment))) {
    return true;
  }

  if (DEV_FILE_NAMES.has(fileName)) {
    return true;
  }

  if (
    DEV_FILE_PREFIXES.some((prefix) => fileName === prefix || fileName.startsWith(`${prefix}.`))
  ) {
    return true;
  }

  if (DEV_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return true;
  }

  return /(^|\/)(tsconfig|jsconfig)(\.[^.]+)?\.json$/i.test(filePath);
}

export function classifyFileChange(filePath: string): FileChangeCategory {
  const normalizedPath = normalizePath(filePath).toLowerCase();
  const segments = getPathSegments(normalizedPath);
  const fileName = segments[segments.length - 1] ?? '';

  // Be conservative: only peel out doc/test/dev when the path is a strong signal.
  // Ambiguous files stay in code so the code-only sidebar count remains useful
  // instead of silently hiding source files with uncommon extensions or layouts.
  if (isTestPath(fileName, segments)) {
    return 'test';
  }
  if (isDocPath(fileName, segments)) {
    return 'doc';
  }
  if (isDevPath(normalizedPath, fileName, segments)) {
    return 'dev';
  }
  return 'code';
}

export function groupFileChangesByCategory<T extends FileChangeLike>(
  entries: readonly T[]
): FileChangeCategoryGroup<T>[] {
  const groups = new Map<FileChangeCategory, FileChangeCategoryGroup<T>>();

  for (const category of FILE_CHANGE_CATEGORY_ORDER) {
    groups.set(category, { category, entries: [], add: 0, del: 0 });
  }

  for (const entry of entries) {
    const category = classifyFileChange(entry.filePath);
    const group = groups.get(category);
    if (!group) {
      continue;
    }
    group.entries.push(entry);
    group.add += entry.add;
    group.del += entry.del;
  }

  return FILE_CHANGE_CATEGORY_ORDER.map((category) => groups.get(category)).filter(
    (group): group is FileChangeCategoryGroup<T> => Boolean(group)
  );
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readAllLineChangeDelta(
  diffStats: SessionDiffStatsLike | null | undefined
): FileChangeLineDelta {
  return {
    add: readNumber(diffStats?.allChange?.add),
    del: readNumber(diffStats?.allChange?.del),
  };
}

export function getLineChangeDeltaForScope(
  diffStats: SessionDiffStatsLike | null | undefined,
  _scope: LineChangeScope
): FileChangeLineDelta {
  return readAllLineChangeDelta(diffStats);
}
