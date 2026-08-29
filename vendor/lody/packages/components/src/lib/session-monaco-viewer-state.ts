export type SessionMonacoResolvedTheme = 'light' | 'dark';

export type SessionMonacoThemeName = string;

export type SessionMonacoSelectedLines =
  | {
      readonly start: number;
      readonly end?: number;
    }
  | null
  | undefined;

export type SessionMonacoLineRange = {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
};

export function getSessionMonacoThemeName(
  resolvedTheme: SessionMonacoResolvedTheme
): 'vs' | 'vs-dark' {
  return resolvedTheme === 'dark' ? 'vs-dark' : 'vs';
}

// Picks the active Monaco theme name: prefers a registered VSCode-derived
// theme (set by `registerMonacoThemeFromVSCodeTheme`) so the viewer mirrors
// the user's chosen VSCode color theme; falls back to the built-in
// `vs` / `vs-dark` when no override is registered.
export function resolveSessionMonacoThemeName(
  resolvedTheme: SessionMonacoResolvedTheme,
  vscodeMonacoThemeName: string | null | undefined
): SessionMonacoThemeName {
  return vscodeMonacoThemeName && vscodeMonacoThemeName.length > 0
    ? vscodeMonacoThemeName
    : getSessionMonacoThemeName(resolvedTheme);
}

export function normalizeSessionMonacoSelectedLines(
  selectedLines: SessionMonacoSelectedLines,
  lineCount: number
): SessionMonacoLineRange | null {
  if (!selectedLines) return null;
  if (!Number.isFinite(selectedLines.start)) return null;
  const rawEnd = selectedLines.end ?? selectedLines.start;
  if (!Number.isFinite(rawEnd)) return null;

  const maxLine = Math.max(1, Math.trunc(lineCount));
  const start = clampLineNumber(selectedLines.start, maxLine);
  const end = clampLineNumber(rawEnd, maxLine);
  return {
    startLineNumber: Math.min(start, end),
    endLineNumber: Math.max(start, end),
  };
}

function clampLineNumber(value: number, maxLine: number): number {
  return Math.min(maxLine, Math.max(1, Math.trunc(value)));
}
