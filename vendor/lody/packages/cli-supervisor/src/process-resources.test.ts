import { describe, expect, it } from 'vitest';
import {
  appendOutputTail,
  calculateWorkerMaxOldSpaceMiB,
  isV8OutOfMemoryExit,
} from './process-resources';

const GIB = 1024 ** 3;

describe('calculateWorkerMaxOldSpaceMiB', () => {
  it.each([
    [2 * GIB, 768],
    [4 * GIB, 819],
    [8 * GIB, 1638],
    [16 * GIB, 3276],
    [64 * GIB, 4096],
  ])('maps %i total bytes to a bounded heap budget', (totalBytes, expectedMiB) => {
    expect(calculateWorkerMaxOldSpaceMiB(totalBytes)).toBe(expectedMiB);
  });

  it('falls back to the minimum for an invalid memory size', () => {
    expect(calculateWorkerMaxOldSpaceMiB(Number.NaN)).toBe(768);
    expect(calculateWorkerMaxOldSpaceMiB(0)).toBe(768);
  });
});

describe('appendOutputTail', () => {
  it('keeps the newest output within the byte cap', () => {
    const output = appendOutputTail('old-prefix-', 'new-suffix', 10);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(10);
    expect(output).toBe('new-suffix');
  });
});

describe('isV8OutOfMemoryExit', () => {
  it('recognizes V8 heap fatal errors from the output tail', () => {
    expect(
      isV8OutOfMemoryExit({ stderr: 'FATAL ERROR: Reached heap limit Allocation failed' })
    ).toBe(true);
  });

  it('does not classify an ordinary process crash as a V8 OOM', () => {
    expect(isV8OutOfMemoryExit({ stderr: 'connection reset by peer' })).toBe(false);
  });
});
