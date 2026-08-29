import type { FlockVersionVector, FlockVersionVectorEntry } from '../../src/local-loro-data-plane';
import type { LocalLoroFlockLike } from '../../src/local-loro-data-plane-server';

/**
 * In-memory Flock fake that mirrors the real @loro-dev/flock semantics the
 * data plane depends on (verified against flock 4.4.4):
 *
 * - entries are self-contained LWW records carrying their own clock
 *   (`c: "physicalTime,logicalCounter,peerId"`);
 * - `version()` is the visible per-peer clock frontier and advances on import;
 * - `exportJson(from)` returns only entries strictly newer than `from`
 *   (`exportJson({})` is a full export);
 * - `importJson` accepts only strictly-newer entries and fires the
 *   subscription (source 'import') ONLY when something was accepted — a no-op
 *   import fires nothing.
 *
 * The clock source is shared across all instances (module-level tick), so
 * cross-instance LWW ordering matches wall-clock HLC behavior.
 */

type Clock = FlockVersionVectorEntry & { peerId: string };

type Entry = { value: unknown; clock: Clock };

type Bundle = { version: number; entries: Record<string, { d: unknown; c: string }> };

let globalTick = 0;
let fakePeerSeq = 0;

function isNewer(a: Clock, b: Clock): boolean {
  if (a.physicalTime !== b.physicalTime) return a.physicalTime > b.physicalTime;
  if (a.logicalCounter !== b.logicalCounter) return a.logicalCounter > b.logicalCounter;
  return a.peerId > b.peerId;
}

function encodeClock(clock: Clock): string {
  return `${clock.physicalTime},${clock.logicalCounter},${clock.peerId}`;
}

function decodeClock(encoded: string): Clock {
  const [physicalTime, logicalCounter, ...peer] = encoded.split(',');
  return {
    physicalTime: Number(physicalTime),
    logicalCounter: Number(logicalCounter),
    peerId: peer.join(','),
  };
}

export class MemoryFlock implements LocalLoroFlockLike {
  private readonly peer: string;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(batch: { source?: string }) => void>();

  constructor(peerId?: string) {
    this.peer = peerId ?? `fake-peer-${++fakePeerSeq}`;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, {
      value,
      clock: { physicalTime: ++globalTick, logicalCounter: 0, peerId: this.peer },
    });
    this.fire('local');
  }

  get(key: string): unknown {
    return this.entries.get(key)?.value;
  }

  version(): FlockVersionVector {
    const version: FlockVersionVector = {};
    for (const entry of this.entries.values()) {
      const existing = version[entry.clock.peerId];
      if (!existing || isNewer(entry.clock, { ...existing, peerId: entry.clock.peerId })) {
        version[entry.clock.peerId] = {
          physicalTime: entry.clock.physicalTime,
          logicalCounter: entry.clock.logicalCounter,
        };
      }
    }
    return version;
  }

  exportJson(from: FlockVersionVector): Bundle {
    const entries: Bundle['entries'] = {};
    for (const [key, entry] of this.entries) {
      const baseline = from[entry.clock.peerId];
      if (!baseline || isNewer(entry.clock, { ...baseline, peerId: entry.clock.peerId })) {
        entries[key] = { d: entry.value, c: encodeClock(entry.clock) };
      }
    }
    return { version: 0, entries };
  }

  importJson(bundle: unknown): void {
    const entries = (bundle as Bundle | null)?.entries ?? {};
    let accepted = 0;
    for (const [key, record] of Object.entries(entries)) {
      const clock = decodeClock(record.c);
      const existing = this.entries.get(key);
      if (existing && !isNewer(clock, existing.clock)) {
        continue;
      }
      this.entries.set(key, { value: record.d, clock });
      accepted += 1;
    }
    if (accepted > 0) {
      this.fire('import');
    }
  }

  subscribe(listener: (batch: { source?: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected fire(source: string): void {
    for (const listener of [...this.listeners]) {
      listener({ source });
    }
  }
}
