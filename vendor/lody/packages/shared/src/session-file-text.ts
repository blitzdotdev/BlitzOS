import { SESSION_FILE_PREVIEW_SNIFF_BYTES } from './ai';

/**
 * Plain-text file extensions eligible for the in-app preview/copy experience.
 * Lowercase, without the leading dot. This is the coarse filter; the content
 * sniff (`sniffLooksLikeText`) is the authority and rejects e.g. a `.bin`
 * renamed to `.txt`.
 *
 * The set MUST be identical across clients (web/desktop/mobile/CLI) so that the
 * `textPreview` flag a sender records matches what every receiver computes.
 */
export const SESSION_FILE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // docs / data
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'log',
  'json',
  'jsonl',
  'ndjson',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'xml',
  'svg',
  // web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  // languages
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'm',
  'mm',
  'cs',
  'php',
  'pl',
  'pm',
  'lua',
  'r',
  'dart',
  'ex',
  'exs',
  'erl',
  'clj',
  'cljs',
  'hs',
  'elm',
  'vue',
  'svelte',
  // shell / config
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'gql',
  'proto',
  'env',
  'gitignore',
  'gitattributes',
  'dockerfile',
  'editorconfig',
  'lock',
  'diff',
  'patch',
  'rst',
  'tex',
  'bat',
  'ps1',
]);

/**
 * Filenames (lowercased) that are text even though they have no extension or an
 * unusual one. Keyed on the full basename, not the extension.
 */
export const SESSION_FILE_TEXT_FILENAMES: ReadonlySet<string> = new Set([
  'dockerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'license',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'notice',
  'copying',
]);

const getLowerBasename = (fileName: string): string => {
  const normalized = fileName.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  return base.toLowerCase();
};

/**
 * Lowercased extension without the leading dot, or undefined when the file has
 * no extension. A leading-dot dotfile with no further dot (e.g. `.gitignore`)
 * is treated as an extension-less name whose basename (`.gitignore` → matched
 * via the filenames/extension allowlist below) drives the decision.
 */
const getExtension = (basename: string): string | undefined => {
  const dot = basename.lastIndexOf('.');
  // No dot, or leading dot with nothing after the name part (dotfile) → no ext.
  if (dot <= 0) {
    return undefined;
  }
  const ext = basename.slice(dot + 1);
  return ext.length > 0 ? ext : undefined;
};

/**
 * Coarse filter: extension on the allowlist, OR declared MIME is `text/*`, OR
 * the file has no extension, OR the basename is a known text filename (e.g.
 * `Dockerfile`, `.gitignore`).
 */
export const passesTextCoarseFilter = (fileName: string, mimeType: string | undefined): boolean => {
  if (mimeType !== undefined && mimeType.toLowerCase().startsWith('text/')) {
    return true;
  }

  const basename = getLowerBasename(fileName);
  if (SESSION_FILE_TEXT_FILENAMES.has(basename)) {
    return true;
  }

  // Dotfiles like `.gitignore` / `.env` are stored in the extension allowlist;
  // check the part after a leading dot too.
  if (basename.startsWith('.')) {
    const dotName = basename.slice(1);
    if (dotName.length > 0 && !dotName.includes('.') && SESSION_FILE_TEXT_EXTENSIONS.has(dotName)) {
      return true;
    }
  }

  const ext = getExtension(basename);
  if (ext === undefined) {
    // No extension → eligible (e.g. `Dockerfile`, `LICENSE`); the content sniff
    // is the gatekeeper.
    return true;
  }

  return SESSION_FILE_TEXT_EXTENSIONS.has(ext);
};

const isUtf8ContinuationByte = (byte: number): boolean => {
  return (byte & 0xc0) === 0x80;
};

/**
 * Length in bytes of the UTF-8 sequence starting with `leadByte`, or 0 if the
 * byte is not a valid lead byte.
 */
const utf8SequenceLength = (leadByte: number): number => {
  if (leadByte < 0x80) {
    return 1;
  }
  if ((leadByte & 0xe0) === 0xc0) {
    return 2;
  }
  if ((leadByte & 0xf0) === 0xe0) {
    return 3;
  }
  if ((leadByte & 0xf8) === 0xf0) {
    return 4;
  }
  return 0;
};

/**
 * Trim a byte slice so it ends on a complete UTF-8 code point boundary. If the
 * slice's tail is the start of a multi-byte sequence that the sniff window
 * truncated, drop that partial sequence before validation so a truncated
 * (otherwise valid) multibyte character is not mistaken for invalid UTF-8.
 *
 * Returns the (possibly shortened) prefix length to validate.
 */
const completeCodePointLength = (bytes: Uint8Array): number => {
  let length = bytes.length;
  // Walk back over continuation bytes (max 3) to find the lead byte.
  let backtrack = 0;
  while (length > 0 && backtrack < 4) {
    const byte = bytes[length - 1] ?? 0;
    if (!isUtf8ContinuationByte(byte)) {
      // `byte` is a lead (or ASCII) byte. Check whether the sequence it starts
      // is fully present within the original slice.
      const seqLen = utf8SequenceLength(byte);
      if (seqLen === 0) {
        // Invalid lead byte — leave it in place; full validation rejects it.
        return bytes.length;
      }
      const seqStart = length - 1;
      if (seqStart + seqLen <= bytes.length) {
        // Whole sequence fits; nothing was truncated.
        return bytes.length;
      }
      // Sequence was cut off by the sniff window → validate up to its start.
      return seqStart;
    }
    length -= 1;
    backtrack += 1;
  }
  return bytes.length;
};

/**
 * Validate that `bytes` is well-formed UTF-8 (after the caller has already
 * trimmed any truncated trailing code point).
 */
const isValidUtf8 = (bytes: Uint8Array): boolean => {
  let i = 0;
  while (i < bytes.length) {
    const leadByte = bytes[i] ?? 0;
    const seqLen = utf8SequenceLength(leadByte);
    if (seqLen === 0) {
      return false;
    }
    if (seqLen === 1) {
      i += 1;
      continue;
    }
    if (i + seqLen > bytes.length) {
      return false;
    }
    let codePoint = leadByte & (0x7f >> seqLen);
    for (let j = 1; j < seqLen; j += 1) {
      const cont = bytes[i + j] ?? 0;
      if (!isUtf8ContinuationByte(cont)) {
        return false;
      }
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }
    // Reject overlong encodings and out-of-range / surrogate code points.
    if (seqLen === 2 && codePoint < 0x80) {
      return false;
    }
    if (seqLen === 3 && codePoint < 0x800) {
      return false;
    }
    if (seqLen === 4 && codePoint < 0x10000) {
      return false;
    }
    if (codePoint > 0x10ffff) {
      return false;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return false;
    }
    i += seqLen;
  }
  return true;
};

/**
 * Content sniff: the prefix contains no NUL byte and is valid UTF-8. The sniff
 * window is truncated to the last complete code point before UTF-8 validation,
 * so a multibyte character split by the 8 KB boundary is not misjudged.
 *
 * Pure and unit-testable; takes only the byte prefix.
 */
export const sniffLooksLikeText = (prefixBytes: Uint8Array): boolean => {
  const window =
    prefixBytes.length > SESSION_FILE_PREVIEW_SNIFF_BYTES
      ? prefixBytes.subarray(0, SESSION_FILE_PREVIEW_SNIFF_BYTES)
      : prefixBytes;

  for (let i = 0; i < window.length; i += 1) {
    if (window[i] === 0x00) {
      return false;
    }
  }

  const validatableLength = completeCodePointLength(window);
  const validatable =
    validatableLength === window.length ? window : window.subarray(0, validatableLength);
  return isValidUtf8(validatable);
};

/**
 * Whether a file is text-previewable: it passes the coarse filter (extension /
 * MIME / no-extension) AND its first ~8 KB sniffs as text (no NUL + valid
 * UTF-8). This is the shared rule recorded as `textPreview` on the file block;
 * the server re-runs the sniff before serving a preview.
 */
export const isTextPreviewable = (
  fileName: string,
  mimeType: string | undefined,
  prefixBytes: Uint8Array
): boolean => {
  if (!passesTextCoarseFilter(fileName, mimeType)) {
    return false;
  }
  return sniffLooksLikeText(prefixBytes);
};
