import { describe, expect, it } from 'vitest';

import {
  TERMINAL_PREVIEW_MAX_BYTES,
  prepareTerminalOutputBlocksPreview,
  prepareTerminalPreview,
} from '../src/components/ai-gui/terminal-preview';

describe('prepareTerminalPreview', () => {
  it('does not return an oversized legacy line to ANSI or the DOM', () => {
    const preview = prepareTerminalPreview('x'.repeat(1024 * 1024));

    expect(preview.wasLimited).toBe(true);
    expect(preview.omittedLongLine).toBe(true);
    expect(preview.text).toContain('omitted');
    expect(preview.text.length).toBeLessThan(256);
  });

  it('keeps a bounded tail from the final adjacent terminal block', () => {
    const preview = prepareTerminalOutputBlocksPreview([
      { output: 'old output\n'.repeat(10_000) },
      { output: 'final diagnostic' },
    ]);

    expect(preview.text).toContain('final diagnostic');
    expect(new TextEncoder().encode(preview.text).byteLength).toBeLessThanOrEqual(
      TERMINAL_PREVIEW_MAX_BYTES
    );
  });
});
