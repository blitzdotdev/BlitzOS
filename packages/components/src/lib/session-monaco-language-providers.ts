import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { isRecord } from '@lody/shared';
import { parseCodeCollabLspLocations, type CodeCollabLspLocation } from './code-collab-lsp-result';
import { hasSessionFileLspProvider, type SessionFileProvider } from './session-file-provider';

// Code Collab Monaco models use this URI scheme so a single global
// `registerDefinitionProvider` / `registerReferenceProvider` can pick
// them out from other Monaco models in the page. The authority carries
// the fileId; the path carries the workspace path so Monaco can infer
// extension-specific language behavior for TSX/JSX while LSP lookup still
// keys only by fileId.
export const CODE_COLLAB_MONACO_URI_SCHEME = 'code-collab';

export function buildCodeCollabMonacoUri(fileId: string, filePath?: string): monaco.Uri {
  const normalizedPath = filePath?.replace(/\\/g, '/').replace(/^\/+/, '');
  return monaco.Uri.from({
    scheme: CODE_COLLAB_MONACO_URI_SCHEME,
    authority: fileId,
    path: normalizedPath && normalizedPath.length > 0 ? `/${normalizedPath}` : '/',
  });
}

export function readFileIdFromCodeCollabMonacoUri(uri: monaco.Uri): string | undefined {
  if (uri.scheme !== CODE_COLLAB_MONACO_URI_SCHEME) return undefined;
  return uri.authority || undefined;
}

// Registry mapping fileId → stack of SessionFileProviders. Each
// `SessionFileContentView` mount pushes its provider; the unmount
// removes that specific entry. Two concurrent mounts (e.g. diff
// viewer + editor on the same file) are common, so single-slot
// storage would let either unmount delete the entry the other still
// depends on. The stack lets the most-recently-mounted viewer drive
// the language providers while every mount safely owns one entry's
// worth of lifecycle.
const providerRegistry = new Map<string, SessionFileProvider[]>();

export function registerCodeCollabMonacoModelProvider(
  fileId: string,
  provider: SessionFileProvider
): () => void {
  let stack = providerRegistry.get(fileId);
  if (!stack) {
    stack = [];
    providerRegistry.set(fileId, stack);
  }
  stack.push(provider);
  return () => {
    const current = providerRegistry.get(fileId);
    if (!current) return;
    // `lastIndexOf` so a re-mount that happens to reuse the same
    // provider instance still removes its own most-recent entry.
    const index = current.lastIndexOf(provider);
    if (index >= 0) {
      current.splice(index, 1);
    }
    if (current.length === 0) {
      providerRegistry.delete(fileId);
    }
  };
}

function findProviderForUri(uri: monaco.Uri): SessionFileProvider | undefined {
  const fileId = readFileIdFromCodeCollabMonacoUri(uri);
  if (!fileId) return undefined;
  const stack = providerRegistry.get(fileId);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

// Helper for parsing the host response: walks `locations` only when
// status is `'ready'`. Everything else (`'unsupported'` / malformed)
// yields an empty list — the Monaco providers degrade silently in
// those cases (the inline `SessionFileLspPanel` is where richer errors
// surface).
function readReadyLocations(raw: unknown): readonly CodeCollabLspLocation[] {
  if (!isRecord(raw)) return [];
  if (raw.status !== 'ready') return [];
  return parseCodeCollabLspLocations(raw.locations);
}

// Converts an LSP-shape range (0-indexed line/character) to a Monaco
// `IRange` (1-indexed line/column with exclusive end column).
function toMonacoRange(range: CodeCollabLspLocation['range']): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// v1 limitation: cross-file definitions / references are dropped here so
// Monaco's Cmd-click stays inside the open editor. Multi-file navigation
// requires either pre-registering Monaco models for every referenced
// fileId or installing an `IEditorOpenContext` opener that routes to the
// application's tab system — both meaningful design pieces we leave for
// when a concrete use case asks for them.
function filterSameFileLocations(
  locations: readonly CodeCollabLspLocation[],
  currentFileId: string
): readonly CodeCollabLspLocation[] {
  return locations.filter((location) => location.fileId === currentFileId);
}

let registered = false;

export function ensureCodeCollabMonacoLanguageProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider(
    { scheme: CODE_COLLAB_MONACO_URI_SCHEME },
    {
      async provideDefinition(model, position) {
        const provider = findProviderForUri(model.uri);
        const fileId = readFileIdFromCodeCollabMonacoUri(model.uri);
        if (!hasSessionFileLspProvider(provider) || !fileId) {
          return null;
        }
        try {
          const raw = await provider.requestLspDefinition(fileId, {
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
          const locations = filterSameFileLocations(readReadyLocations(raw), fileId);
          return locations.map((location) => ({
            uri: model.uri,
            range: toMonacoRange(location.range),
          }));
        } catch {
          // LSP failures fall back to "no definition" rather than
          // surfacing a Monaco-level error. The inline LSP panel
          // (`SessionFileLspPanel`) already shows actionable error
          // messages when the user invokes via the editor action; this
          // path is the Cmd-click hover affordance, which is best left
          // silent on the host being offline.
          return null;
        }
      },
    }
  );

  monaco.languages.registerReferenceProvider(
    { scheme: CODE_COLLAB_MONACO_URI_SCHEME },
    {
      async provideReferences(model, position) {
        const provider = findProviderForUri(model.uri);
        const fileId = readFileIdFromCodeCollabMonacoUri(model.uri);
        if (!hasSessionFileLspProvider(provider) || !fileId) {
          return null;
        }
        try {
          const raw = await provider.requestLspReferences(
            fileId,
            { line: position.lineNumber - 1, character: position.column - 1 },
            { includeDeclaration: true }
          );
          const locations = filterSameFileLocations(readReadyLocations(raw), fileId);
          return locations.map((location) => ({
            uri: model.uri,
            range: toMonacoRange(location.range),
          }));
        } catch {
          return null;
        }
      },
    }
  );
}
