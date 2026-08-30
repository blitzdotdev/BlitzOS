import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  LodyResolvedVSCodeThemeSchema,
  TextMateTokenColorRuleSchema,
  VSCodeColorThemeJsonSchema,
  VSCodeExtensionManifestSchema,
  type LodyResolvedVSCodeTheme,
  type LodyResolvedVSCodeThemeType,
  type TextMateTokenColorRule,
  type VSCodeExtensionManifest,
  type VSCodeThemeContribution,
} from './vscode-theme-schemas';
import { normalizeHexColor } from './vscode-theme-color';

type ThemeSource = LodyResolvedVSCodeTheme['source'];

export type VSCodeThemeFileReader = (path: string) => Promise<string> | string;
export type VSCodeThemeSyncFileReader = (path: string) => string;

export type ResolveVSCodeThemeOptions = {
  id: string;
  label: string;
  uiTheme: VSCodeThemeContribution['uiTheme'];
  path: string;
  source: ThemeSource;
  readFile: VSCodeThemeFileReader;
};

type PartialResolvedTheme = Pick<
  LodyResolvedVSCodeTheme,
  'colors' | 'tokenColors' | 'semanticTokenColors'
>;

type ParsedThemeFile = {
  include?: string;
  colors?: Record<string, unknown>;
  tokenColors?: unknown[] | string;
  semanticTokenColors?: Record<string, unknown>;
};

type NormalizedThemeLayer = PartialResolvedTheme & {
  defaultColorIds: string[];
};

const MAX_INCLUDE_DEPTH = 32;

export const parseVSCodeExtensionManifest = (rawManifest: unknown): VSCodeExtensionManifest => {
  const result = VSCodeExtensionManifestSchema.safeParse(rawManifest);
  if (!result.success) {
    throw new Error(`Invalid VSCode extension manifest: ${result.error.message}`);
  }
  return result.data;
};

export const getVSCodeThemeContributions = (
  manifest: VSCodeExtensionManifest
): VSCodeThemeContribution[] => manifest.contributes?.themes ?? [];

export const resolveVSCodeTheme = async ({
  id,
  label,
  uiTheme,
  path,
  source,
  readFile,
}: ResolveVSCodeThemeOptions): Promise<LodyResolvedVSCodeTheme> => {
  const themePath = normalizeRootRelativePath(path);
  const resolvedLayer = await resolveThemeFile(themePath, readFile, new Set(), 0);
  const runtimeTheme: LodyResolvedVSCodeTheme = {
    schemaVersion: 1,
    id,
    label,
    type: normalizeUiTheme(uiTheme),
    source,
    colors: resolvedLayer.colors,
    tokenColors: resolvedLayer.tokenColors,
    semanticTokenColors: resolvedLayer.semanticTokenColors,
  };
  const result = LodyResolvedVSCodeThemeSchema.safeParse(runtimeTheme);
  if (!result.success) {
    throw new Error(`Resolved VSCode theme "${id}" is invalid: ${result.error.message}`);
  }
  return result.data;
};

export const resolveVSCodeThemeSync = ({
  id,
  label,
  uiTheme,
  path,
  source,
  readFile,
}: Omit<ResolveVSCodeThemeOptions, 'readFile'> & {
  readFile: VSCodeThemeSyncFileReader;
}): LodyResolvedVSCodeTheme => {
  const themePath = normalizeRootRelativePath(path);
  const resolvedLayer = resolveThemeFileSync(themePath, readFile, new Set(), 0);
  const runtimeTheme: LodyResolvedVSCodeTheme = {
    schemaVersion: 1,
    id,
    label,
    type: normalizeUiTheme(uiTheme),
    source,
    colors: resolvedLayer.colors,
    tokenColors: resolvedLayer.tokenColors,
    semanticTokenColors: resolvedLayer.semanticTokenColors,
  };
  const result = LodyResolvedVSCodeThemeSchema.safeParse(runtimeTheme);
  if (!result.success) {
    throw new Error(`Resolved VSCode theme "${id}" is invalid: ${result.error.message}`);
  }
  return result.data;
};

const resolveThemeFile = async (
  themePath: string,
  readFile: VSCodeThemeFileReader,
  includeStack: Set<string>,
  depth: number
): Promise<NormalizedThemeLayer> => {
  if (includeStack.has(themePath)) {
    throw new Error(
      `VSCode theme include cycle detected: ${[...includeStack, themePath].join(' -> ')}`
    );
  }
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`VSCode theme include depth exceeded ${MAX_INCLUDE_DEPTH}`);
  }

  try {
    includeStack.add(themePath);
    const rawTheme = await readFile(themePath);
    const parsedTheme = parseVSCodeThemeJson(rawTheme, themePath);

    const base = parsedTheme.include
      ? await resolveThemeFile(
          resolvePathReference(themePath, parsedTheme.include),
          readFile,
          includeStack,
          depth + 1
        )
      : emptyResolvedTheme();

    return mergeResolvedTheme(base, normalizeParsedTheme(parsedTheme, themePath));
  } finally {
    includeStack.delete(themePath);
  }
};

const resolveThemeFileSync = (
  themePath: string,
  readFile: VSCodeThemeSyncFileReader,
  includeStack: Set<string>,
  depth: number
): NormalizedThemeLayer => {
  if (includeStack.has(themePath)) {
    throw new Error(
      `VSCode theme include cycle detected: ${[...includeStack, themePath].join(' -> ')}`
    );
  }
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`VSCode theme include depth exceeded ${MAX_INCLUDE_DEPTH}`);
  }

  try {
    includeStack.add(themePath);
    const rawTheme = readFile(themePath);
    const parsedTheme = parseVSCodeThemeJson(rawTheme, themePath);

    const base = parsedTheme.include
      ? resolveThemeFileSync(
          resolvePathReference(themePath, parsedTheme.include),
          readFile,
          includeStack,
          depth + 1
        )
      : emptyResolvedTheme();

    return mergeResolvedTheme(base, normalizeParsedTheme(parsedTheme, themePath));
  } finally {
    includeStack.delete(themePath);
  }
};

const parseVSCodeThemeJson = (rawTheme: string, themePath: string): ParsedThemeFile => {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(rawTheme, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid JSONC in VSCode theme "${themePath}": ${errors[0]?.error}`);
  }
  const result = VSCodeColorThemeJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid VSCode theme "${themePath}": ${result.error.message}`);
  }
  return result.data;
};

const normalizeParsedTheme = (theme: ParsedThemeFile, themePath: string): NormalizedThemeLayer => {
  if (typeof theme.tokenColors === 'string') {
    throw new Error(
      `VSCode theme "${themePath}" uses external tokenColors "${theme.tokenColors}", which is not supported yet`
    );
  }

  return {
    ...normalizeColors(theme.colors ?? {}),
    tokenColors: normalizeTokenColors(theme.tokenColors ?? [], themePath),
    semanticTokenColors: theme.semanticTokenColors,
  };
};

const normalizeColors = (
  colors: Record<string, unknown>
): Pick<NormalizedThemeLayer, 'colors' | 'defaultColorIds'> => {
  const normalized: Record<string, string> = {};
  const defaultColorIds: string[] = [];
  for (const [colorId, rawColor] of Object.entries(colors)) {
    if (typeof rawColor !== 'string') {
      if (rawColor === null) {
        defaultColorIds.push(colorId);
      }
      continue;
    }
    if (rawColor === 'default' || rawColor.trim() === '') {
      defaultColorIds.push(colorId);
      continue;
    }
    normalized[colorId] = normalizeHexColor(rawColor);
  }
  return { colors: normalized, defaultColorIds };
};

const normalizeTokenColors = (
  tokenColors: unknown[],
  themePath: string
): TextMateTokenColorRule[] => {
  return tokenColors.map((tokenColor, index) => {
    const coerced = coerceTokenColorRule(tokenColor);
    const result = TextMateTokenColorRuleSchema.safeParse(coerced);
    if (!result.success) {
      throw new Error(
        `Invalid token color rule at "${themePath}"[${index}]: ${result.error.message}`
      );
    }
    return result.data;
  });
};

const coerceTokenColorRule = (tokenColor: unknown): unknown => {
  if (!isRecord(tokenColor)) {
    return tokenColor;
  }
  const settings = isRecord(tokenColor.settings) ? tokenColor.settings : {};
  return {
    name: typeof tokenColor.name === 'string' ? tokenColor.name : undefined,
    scope: normalizeTokenScope(tokenColor.scope),
    settings: {
      foreground:
        typeof settings.foreground === 'string'
          ? normalizeHexColor(settings.foreground)
          : undefined,
      background:
        typeof settings.background === 'string'
          ? normalizeHexColor(settings.background)
          : undefined,
      fontStyle: typeof settings.fontStyle === 'string' ? settings.fontStyle : undefined,
    },
  };
};

const normalizeTokenScope = (scope: unknown): string | string[] | undefined => {
  if (typeof scope === 'string') {
    return scope;
  }
  if (Array.isArray(scope) && scope.every((item) => typeof item === 'string')) {
    return scope;
  }
  return undefined;
};

const mergeResolvedTheme = (
  base: NormalizedThemeLayer,
  override: NormalizedThemeLayer
): NormalizedThemeLayer => {
  const colors = {
    ...base.colors,
    ...override.colors,
  };
  for (const colorId of override.defaultColorIds) {
    delete colors[colorId];
  }

  return {
    colors,
    defaultColorIds: [...base.defaultColorIds, ...override.defaultColorIds],
    tokenColors: [...base.tokenColors, ...override.tokenColors],
    semanticTokenColors: {
      ...(base.semanticTokenColors ?? {}),
      ...(override.semanticTokenColors ?? {}),
    },
  };
};

const emptyResolvedTheme = (): NormalizedThemeLayer => ({
  colors: {},
  defaultColorIds: [],
  tokenColors: [],
});

const normalizeUiTheme = (
  uiTheme: VSCodeThemeContribution['uiTheme']
): LodyResolvedVSCodeThemeType => {
  switch (uiTheme) {
    case 'vs':
      return 'light';
    case 'vs-dark':
      return 'dark';
    case 'hc-light':
      return 'hcLight';
    case 'hc-black':
      return 'hcDark';
  }
  throw new Error(`Unsupported VSCode uiTheme: ${String(uiTheme)}`);
};

const resolvePathReference = (fromPath: string, reference: string): string => {
  const baseParts = normalizeRootRelativePath(fromPath).split('/').slice(0, -1);
  return normalizeRootRelativePath([...baseParts, reference].join('/'));
};

const normalizeRootRelativePath = (path: string): string => {
  const parts: string[] = [];
  const normalizedSeparators = path.replace(/\\/g, '/');
  if (/^(?:[a-zA-Z]:|\/)/.test(normalizedSeparators)) {
    throw new Error(`VSCode theme path must be extension-relative: "${path}"`);
  }

  for (const segment of normalizedSeparators.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length === 0) {
        throw new Error(`VSCode theme path escapes extension root: "${path}"`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  if (parts.length === 0) {
    throw new Error(`VSCode theme path is empty: "${path}"`);
  }
  return parts.join('/');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
