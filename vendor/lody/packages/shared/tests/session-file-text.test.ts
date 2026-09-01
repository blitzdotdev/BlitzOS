import { describe, expect, it } from 'vitest';

import {
  isTextPreviewable,
  passesTextCoarseFilter,
  sniffLooksLikeText,
} from '../src/session-file-text';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

describe('passesTextCoarseFilter', () => {
  it('accepts allowlisted extensions', () => {
    expect(passesTextCoarseFilter('notes.md', undefined)).toBe(true);
    expect(passesTextCoarseFilter('data.JSON', undefined)).toBe(true);
    expect(passesTextCoarseFilter('main.tsx', undefined)).toBe(true);
  });

  it('accepts text/* mime regardless of extension', () => {
    expect(passesTextCoarseFilter('mystery.dat', 'text/plain')).toBe(true);
    expect(passesTextCoarseFilter('x.unknown', 'text/markdown; charset=utf-8')).toBe(true);
  });

  it('accepts extension-less files (e.g. Dockerfile, LICENSE)', () => {
    expect(passesTextCoarseFilter('Dockerfile', undefined)).toBe(true);
    expect(passesTextCoarseFilter('LICENSE', undefined)).toBe(true);
    expect(passesTextCoarseFilter('some/path/Makefile', undefined)).toBe(true);
  });

  it('accepts dotfiles whose name is an allowlisted extension', () => {
    expect(passesTextCoarseFilter('.gitignore', undefined)).toBe(true);
    expect(passesTextCoarseFilter('.env', undefined)).toBe(true);
  });

  it('rejects non-text extensions without a text mime', () => {
    expect(passesTextCoarseFilter('photo.png', undefined)).toBe(false);
    expect(passesTextCoarseFilter('archive.zip', 'application/zip')).toBe(false);
    expect(passesTextCoarseFilter('binary.bin', undefined)).toBe(false);
  });
});

describe('sniffLooksLikeText', () => {
  it('accepts empty input', () => {
    expect(sniffLooksLikeText(new Uint8Array(0))).toBe(true);
  });

  it('accepts pure ASCII', () => {
    expect(sniffLooksLikeText(bytes('hello world\nsecond line\t'))).toBe(true);
  });

  it('accepts valid multibyte UTF-8', () => {
    expect(sniffLooksLikeText(bytes('héllo 世界 🚀'))).toBe(true);
  });

  it('rejects a NUL byte', () => {
    expect(sniffLooksLikeText(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe(false);
  });

  it('rejects invalid UTF-8 (lone continuation byte)', () => {
    expect(sniffLooksLikeText(new Uint8Array([0x80]))).toBe(false);
  });

  it('rejects invalid UTF-8 (overlong / bad lead)', () => {
    // 0xFF is never a valid UTF-8 lead byte.
    expect(sniffLooksLikeText(new Uint8Array([0x41, 0xff, 0x42]))).toBe(false);
  });

  it('tolerates a multibyte code point truncated by the sniff window', () => {
    // "界" (U+754C) is 0xE7 0x95 0x8C. Cut after the first byte: the truncated
    // partial sequence must be ignored, not treated as invalid UTF-8.
    const full = bytes('ok界');
    const cut = full.subarray(0, full.length - 2); // drop last 2 of the 3-byte char
    expect(sniffLooksLikeText(cut)).toBe(true);
  });

  it('tolerates truncation in the middle of a 4-byte emoji', () => {
    const full = bytes('a🚀'); // 🚀 = 0xF0 0x9F 0x9A 0x80
    expect(sniffLooksLikeText(full.subarray(0, full.length - 1))).toBe(true);
    expect(sniffLooksLikeText(full.subarray(0, full.length - 2))).toBe(true);
    expect(sniffLooksLikeText(full.subarray(0, full.length - 3))).toBe(true);
  });

  it('only sniffs the first 8 KB', () => {
    const prefix = new Uint8Array(8 * 1024).fill(0x41); // 8 KB of 'A'
    const withTrailingNul = new Uint8Array(prefix.length + 1);
    withTrailingNul.set(prefix);
    withTrailingNul[prefix.length] = 0x00; // NUL just past the window
    expect(sniffLooksLikeText(withTrailingNul)).toBe(true);

    const nulInsideWindow = new Uint8Array(prefix);
    nulInsideWindow[10] = 0x00;
    expect(sniffLooksLikeText(nulInsideWindow)).toBe(false);
  });
});

describe('isTextPreviewable', () => {
  it('passes a real text file', () => {
    expect(isTextPreviewable('readme.md', 'text/markdown', bytes('# Title\nbody'))).toBe(true);
  });

  it('passes an extension-less Dockerfile with text content', () => {
    expect(isTextPreviewable('Dockerfile', undefined, bytes('FROM node:20\nRUN echo hi'))).toBe(
      true
    );
  });

  it('rejects a .bin renamed to .txt (sniff blocks it)', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    // Coarse filter passes (.txt) but the NUL byte fails the sniff.
    expect(passesTextCoarseFilter('payload.txt', undefined)).toBe(true);
    expect(isTextPreviewable('payload.txt', undefined, binary)).toBe(false);
  });

  it('rejects a binary file even with text content sniff when coarse filter fails', () => {
    expect(isTextPreviewable('image.png', undefined, bytes('not really a png'))).toBe(false);
  });

  it('treats an empty text file as previewable', () => {
    expect(isTextPreviewable('empty.txt', undefined, new Uint8Array(0))).toBe(true);
  });
});
