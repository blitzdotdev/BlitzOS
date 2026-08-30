// Shared parser for the Code Collab LSP RPC response payload. Components only
// see the JSON shape over the wire.
// Used by `useCodeCollabLsp` and by the Monaco
// definition/reference providers in
// `session-monaco-language-providers.ts`.

import { isRecord } from '@lody/shared';

export type CodeCollabLspLocation = {
  readonly fileId: string;
  readonly path: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
};

export type CodeCollabLspResult =
  | {
      readonly status: 'ready';
      readonly provider: string;
      readonly locations: readonly CodeCollabLspLocation[];
    }
  | {
      readonly status: 'unsupported';
      readonly message: string;
      readonly locations: readonly [];
    };

// Parses an arbitrary JSON value into the typed LSP result. Returns
// undefined if the shape doesn't match the contract — callers treat
// that as an error condition (the underlying RPC succeeded but the
// response is malformed, so there's nothing useful to show).
export function parseCodeCollabLspResult(value: unknown): CodeCollabLspResult | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const status = record.status;
  if (status === 'unsupported') {
    const message = typeof record.message === 'string' ? record.message : 'LSP not supported';
    return { status: 'unsupported', message, locations: [] };
  }
  if (status !== 'ready') return undefined;
  const provider = typeof record.provider === 'string' ? record.provider : 'unknown';
  return {
    status: 'ready',
    provider,
    locations: parseCodeCollabLspLocations(record.locations),
  };
}

// Parses just the locations array. Useful for callers that already
// branch on `status` and only need the location list (e.g. Monaco
// language providers that filter by same-file before mapping to
// `monaco.languages.Location`).
export function parseCodeCollabLspLocations(value: unknown): readonly CodeCollabLspLocation[] {
  const raw = Array.isArray(value) ? value : [];
  const out: CodeCollabLspLocation[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const loc = candidate;
    const fileId = typeof loc.fileId === 'string' ? loc.fileId : null;
    const path = typeof loc.path === 'string' ? loc.path : null;
    if (!fileId || !path || !isRecord(loc.range)) continue;
    const range = loc.range;
    if (!isRecord(range.start) || !isRecord(range.end)) continue;
    const start = range.start;
    const end = range.end;
    if (
      typeof start.line !== 'number' ||
      typeof start.character !== 'number' ||
      typeof end.line !== 'number' ||
      typeof end.character !== 'number'
    ) {
      continue;
    }
    out.push({
      fileId,
      path,
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
    });
  }
  return out;
}
