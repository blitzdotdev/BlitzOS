import { describe, expect, it } from 'vitest';
import { parseDarwinTopMemory } from './process-table';

describe('parseDarwinTopMemory', () => {
  it('parses macOS top MEM values as binary byte units', () => {
    const memory = parseDarwinTopMemory(`
Processes: 412 total, 2 running, 410 sleeping
PhysMem: 18G used, 14G unused.

PID    MEM
101    512K
202    128M
303    1.5G
404    42M+
`);

    expect(memory).toEqual(
      new Map([
        [101, 512 * 1024],
        [202, 128 * 1024 ** 2],
        [303, Math.round(1.5 * 1024 ** 3)],
        [404, 42 * 1024 ** 2],
      ])
    );
  });

  it('ignores headers and malformed rows', () => {
    expect(
      parseDarwinTopMemory(`
PID MEM
not-a-pid 10M
123 unknown
456 0B
`)
    ).toEqual(new Map([[456, 0]]));
  });
});
