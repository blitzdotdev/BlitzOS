import { describe, expect, it } from 'vitest';
import {
  computeCgroupReclaimableBytes,
  computeWindowsCommitGrowthBytes,
  getAvailableMemoryBytes,
  parseCgroupMemoryEvents,
  parseCgroupMemoryStat,
  parseCgroupPressureSomeAvg10,
  parseDarwinAvailableMemoryBytes,
  parseDarwinPressureLevel,
  parseWindowsMemoryStatus,
} from './memory';

describe('getAvailableMemoryBytes', () => {
  it('returns a positive number', () => {
    const result = getAvailableMemoryBytes();
    expect(result).toBeGreaterThan(0);
  });

  it('returns a number in a reasonable range (> 10MB)', () => {
    const result = getAvailableMemoryBytes();
    // Any modern system should have at least 10MB available
    expect(result).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('parses reclaimable memory from vm_stat output on darwin', () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                8177.
Pages active:                            189421.
Pages inactive:                          187645.
Pages speculative:                          904.
Pages wired down:                        156602.
Pages purgeable:                           3890.
File-backed pages:                       124000.
`;

    const result = parseDarwinAvailableMemoryBytes(output);

    expect(result).toBe((8177 + 904 + 3890 + Math.min(124000, 187645)) * 16384);
  });

  it('returns null when vm_stat output is malformed', () => {
    expect(parseDarwinAvailableMemoryBytes('not vm_stat')).toBeNull();
  });
});

describe('windows commit headroom', () => {
  const GIB = 1024 * 1024 * 1024;
  const MIB = 1024 * 1024;
  const RAM = 16 * GIB;
  const VOLUME = { DeviceID: 'C:', FreeSpace: 200 * GIB, Size: 500 * GIB };

  it('reads the documented perf counters and credits page file growth', () => {
    // A stock machine: 16GB RAM, a 2GB system-managed page file, commit charge close to the
    // current limit. The old reading called this "256MB left" and refused the turn.
    const result = parseWindowsMemoryStatus(
      JSON.stringify({
        CommitLimit: 18 * GIB,
        CommittedBytes: 18 * GIB - 256 * MIB,
        AutomaticManagedPagefile: true,
        PageFiles: [{ Name: 'C:\\pagefile.sys', AllocatedBaseSize: 2048 }],
        PageFileSettings: [],
        Volumes: [VOLUME],
      }),
      RAM
    );

    expect(result).toEqual({
      commitLimitBytes: 18 * GIB,
      committedBytes: 18 * GIB - 256 * MIB,
      availableCommitBytes: 256 * MIB,
      // System-managed ceiling is min(max(3 x RAM, 4GB), volume/8) = min(48GB, 62.5GB) = 48GB,
      // minus the 2GB already allocated.
      commitGrowthBytes: 46 * GIB,
      effectiveAvailableCommitBytes: 46 * GIB + 256 * MIB,
    });
  });

  it('falls back to Win32_OperatingSystem when the perf provider reports nothing', () => {
    const result = parseWindowsMemoryStatus(
      JSON.stringify({
        TotalVirtualMemorySize: (18 * GIB) / 1024,
        FreeVirtualMemory: (256 * MIB) / 1024,
        AutomaticManagedPagefile: true,
        PageFiles: [{ Name: 'C:\\pagefile.sys', AllocatedBaseSize: 2048 }],
        PageFileSettings: [],
        Volumes: [VOLUME],
      }),
      RAM
    );

    expect(result?.commitLimitBytes).toBe(18 * GIB);
    expect(result?.availableCommitBytes).toBe(256 * MIB);
    expect(result?.commitGrowthBytes).toBe(46 * GIB);
  });

  it('reports a fixed ceiling when paging is disabled', () => {
    const result = parseWindowsMemoryStatus(
      JSON.stringify({
        CommitLimit: RAM,
        CommittedBytes: RAM - 256 * MIB,
        AutomaticManagedPagefile: false,
        PageFiles: [],
        PageFileSettings: [],
        Volumes: [VOLUME],
      }),
      RAM
    );

    expect(result?.commitGrowthBytes).toBe(0);
    expect(result?.effectiveAvailableCommitBytes).toBe(256 * MIB);
  });

  it('omits the effective headroom when page file growth is undetermined', () => {
    // An empty enumeration on a machine whose commit limit clearly exceeds RAM means the query
    // failed, not that paging is off. Reporting 0 growth here would refuse a healthy machine.
    const result = parseWindowsMemoryStatus(
      JSON.stringify({
        CommitLimit: 18 * GIB,
        CommittedBytes: 18 * GIB - 256 * MIB,
        AutomaticManagedPagefile: true,
        PageFiles: [],
        PageFileSettings: [],
        Volumes: [VOLUME],
      }),
      RAM
    );

    expect(result?.availableCommitBytes).toBe(256 * MIB);
    expect(result?.commitGrowthBytes).toBeNull();
    expect(result?.effectiveAvailableCommitBytes).toBeUndefined();
  });

  it('accepts CIM string numbers and a single row sent as a bare object', () => {
    const result = parseWindowsMemoryStatus(
      JSON.stringify({
        TotalVirtualMemorySize: String((18 * GIB) / 1024),
        FreeVirtualMemory: String((512 * MIB) / 1024),
        AutomaticManagedPagefile: false,
        PageFiles: { Name: 'C:\\pagefile.sys', AllocatedBaseSize: '2048' },
        PageFileSettings: { Name: 'C:\\pagefile.sys', MaximumSize: '4096' },
        Volumes: { DeviceID: 'C:', FreeSpace: String(200 * GIB), Size: String(500 * GIB) },
      }),
      RAM
    );

    expect(result?.commitGrowthBytes).toBe(2 * GIB);
  });

  it('returns null when the probe output is malformed', () => {
    expect(parseWindowsMemoryStatus('{"CommitLimit":"nope"}', RAM)).toBeNull();
    expect(parseWindowsMemoryStatus('powershell exploded', RAM)).toBeNull();
  });
});

describe('computeWindowsCommitGrowthBytes', () => {
  const GIB = 1024 * 1024 * 1024;
  const MIB = 1024 * 1024;
  const RAM = 16 * GIB;
  const inputs = (commitLimitBytes: number, totalPhysicalBytes = RAM) => ({
    totalPhysicalBytes,
    commitLimitBytes,
  });

  it('stops at the configured maximum size', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: false,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 8 * GIB }],
          pageFileSettings: [{ name: 'C:\\pagefile.sys', maximumBytes: 8 * GIB }],
          volumes: [{ name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB }],
        },
        inputs(24 * GIB)
      )
    ).toBe(0);
  });

  it('stops at one eighth of the volume, which binds on a small disk', () => {
    // 32GB RAM would allow a 96GB page file by the RAM rule, and 80GB of free space would
    // allow 80GB — but Microsoft caps a system-managed file at one eighth of the volume.
    // Small-disk machines are exactly the ones that actually run out of commit, so this term
    // must be modelled or the guard silently stops protecting them.
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 4 * GIB }],
          pageFileSettings: [],
          volumes: [{ name: 'C:', freeBytes: 80 * GIB, sizeBytes: 256 * GIB }],
        },
        inputs(36 * GIB, 32 * GIB)
      )
    ).toBe(28 * GIB);
  });

  it('stops at free disk space, which a page file cannot grow past', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 2 * GIB }],
          pageFileSettings: [],
          volumes: [{ name: 'C:', freeBytes: 300 * MIB, sizeBytes: 500 * GIB }],
        },
        inputs(18 * GIB)
      )
    ).toBe(300 * MIB);
  });

  it('sums every page file and matches each one to its own volume', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: false,
          pageFiles: [
            { name: 'C:\\pagefile.sys', allocatedBytes: 2 * GIB },
            { name: 'D:\\pagefile.sys', allocatedBytes: 1 * GIB },
          ],
          pageFileSettings: [
            { name: 'C:\\pagefile.sys', maximumBytes: 6 * GIB },
            { name: 'D:\\pagefile.sys', maximumBytes: 9 * GIB },
          ],
          volumes: [
            { name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB },
            { name: 'D:', freeBytes: 3 * GIB, sizeBytes: 500 * GIB },
          ],
        },
        inputs(19 * GIB)
      )
    ).toBe(4 * GIB + 3 * GIB);
  });

  it('ignores stale explicit settings while Windows manages the page files', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 2 * GIB }],
          pageFileSettings: [{ name: 'C:\\pagefile.sys', maximumBytes: 2 * GIB }],
          volumes: [{ name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB }],
        },
        inputs(18 * GIB)
      )
    ).toBe(46 * GIB);
  });

  it('uses the 4GB floor on a machine with very little RAM', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 0 }],
          pageFileSettings: [],
          volumes: [{ name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB }],
        },
        inputs(1 * GIB, 1 * GIB)
      )
    ).toBe(4 * GIB);
  });

  it('returns null when a page file volume was not reported', () => {
    // Undetermined, NOT zero: a failed disk query must never be read as a fixed ceiling.
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [{ name: 'C:\\pagefile.sys', allocatedBytes: 2 * GIB }],
          pageFileSettings: [],
          volumes: [],
        },
        inputs(18 * GIB)
      )
    ).toBeNull();
  });

  it('returns null when the commit limit proves a page file the enumeration missed', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: true,
          pageFiles: [],
          pageFileSettings: [],
          volumes: [{ name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB }],
        },
        inputs(18 * GIB)
      )
    ).toBeNull();
  });

  it('reports zero only when the commit limit corroborates that paging is off', () => {
    expect(
      computeWindowsCommitGrowthBytes(
        {
          automaticManagedPagefile: false,
          pageFiles: [],
          pageFileSettings: [],
          volumes: [{ name: 'C:', freeBytes: 200 * GIB, sizeBytes: 500 * GIB }],
        },
        inputs(RAM)
      )
    ).toBe(0);
  });
});

describe('cgroup v2 memory parsing', () => {
  // Trimmed from a real /sys/fs/cgroup/.../memory.stat.
  const memoryStat = `anon 4054687744
file 12066566144
kernel 812345678
slab_reclaimable 646001912
slab_unreclaimable 5114080
file_dirty 1732608
file_writeback 0
inactive_anon 4000000000
active_anon 54687744
inactive_file 2449469440
active_file 9617096704
`;

  it('reads the file and slab counters it needs', () => {
    expect(parseCgroupMemoryStat(memoryStat)).toEqual({
      inactiveFileBytes: 2449469440,
      activeFileBytes: 9617096704,
      slabReclaimableBytes: 646001912,
      dirtyBytes: 1732608,
    });
  });

  it('treats a missing memory.stat as all zeroes rather than throwing', () => {
    expect(parseCgroupMemoryStat('')).toEqual({
      inactiveFileBytes: 0,
      activeFileBytes: 0,
      slabReclaimableBytes: 0,
      dirtyBytes: 0,
    });
  });

  it('credits clean inactive file cache and half of reclaimable slab', () => {
    const stat = parseCgroupMemoryStat(memoryStat);
    expect(computeCgroupReclaimableBytes(stat)).toBe(
      2449469440 - 1732608 + Math.floor(646001912 / 2)
    );
  });

  it('excludes active file cache, which is why a stall signal gates blocking', () => {
    const stat = parseCgroupMemoryStat(memoryStat);
    expect(computeCgroupReclaimableBytes(stat)).toBeLessThan(stat.activeFileBytes);
  });

  it('never credits dirty pages that must be written out first', () => {
    expect(
      computeCgroupReclaimableBytes({
        inactiveFileBytes: 1000,
        activeFileBytes: 0,
        slabReclaimableBytes: 0,
        dirtyBytes: 4000,
      })
    ).toBe(0);
  });

  it('reads the PSI some avg10 stall share', () => {
    const pressure = `some avg10=12.34 avg60=4.00 avg300=1.00 total=68381479
full avg10=6.00 avg60=2.00 avg300=0.50 total=62637781
`;
    expect(parseCgroupPressureSomeAvg10(pressure)).toBe(12.34);
    // "full" must not be mistaken for "some": it is a strictly smaller number.
    expect(parseCgroupPressureSomeAvg10('full avg10=6.00 avg60=2.00\n')).toBeNull();
    expect(parseCgroupPressureSomeAvg10('')).toBeNull();
  });

  it('reads the throttle event counters', () => {
    const events = `low 0
high 17
max 3
oom 0
oom_kill 0
`;
    expect(parseCgroupMemoryEvents(events)).toEqual({ high: 17, max: 3 });
    expect(parseCgroupMemoryEvents('low 0\n')).toBeNull();
    expect(parseCgroupMemoryEvents('')).toBeNull();
  });
});

describe('parseDarwinPressureLevel', () => {
  it('parses the three levels the kernel can report', () => {
    // `sysctl -n` emits a bare integer plus a trailing newline.
    expect(parseDarwinPressureLevel('1\n')).toBe(1);
    expect(parseDarwinPressureLevel('2\n')).toBe(2);
    expect(parseDarwinPressureLevel('4\n')).toBe(4);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDarwinPressureLevel('  4  ')).toBe(4);
  });

  it.each([
    ['empty output', ''],
    ['sysctl error text', 'sysctl: unknown oid'],
    ['a level this code does not understand', '3'],
    ['a non-integer', '2.5'],
  ])('returns null for %s so the caller fails open', (_label, raw) => {
    expect(parseDarwinPressureLevel(raw)).toBeNull();
  });
});
