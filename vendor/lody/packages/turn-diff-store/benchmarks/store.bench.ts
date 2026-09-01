/**
 * End-to-end benchmark for the production turn-diff-store package.
 *
 * It includes string transfer to the persistent Worker, FastCDC, SHA-256,
 * compression, SQLite WAL commit, snapshot reconstruction, and transfer back.
 *
 * Run from the repository root:
 *   pnpm --filter @lody/turn-diff-store bench
 *   pnpm --filter @lody/turn-diff-store bench -- --turns=40 --files=8 --file-kib=512
 *   pnpm --filter @lody/turn-diff-store bench -- --worker=apps/cli/dist/turn-diff-store-worker.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  TurnDiffStore,
  type RecordTurnDiffMetrics,
  type TurnDiffCompression,
  type TurnDiffStoreStats,
} from '../src/index';
import { FASTCDC_PROFILE_ID } from '../src/fastcdc';

interface BenchmarkOptions {
  readonly turns: number;
  readonly files: number;
  readonly fileBytes: number;
  readonly editBytes: number;
  readonly compression: TurnDiffCompression;
  readonly workerPath: string | null;
  readonly json: boolean;
}

interface TurnFixture {
  readonly turnId: string;
  readonly events: readonly {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly add: number;
    readonly del: number;
  }[];
}

interface Observation {
  readonly roundTripMs: number;
  readonly metrics: RecordTurnDiffMetrics;
}

const options = parseOptions(process.argv.slice(2));
const fixtures = createFixtures(options);
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'lody-turn-diff-bench-'));
const dbPath = path.join(temporaryDirectory, 'turn-diffs.sqlite3');
const backgroundErrors: Error[] = [];
const store = new TurnDiffStore({
  dbPath,
  now: () => 1_000 + fixtures.length,
  compression: options.compression,
  workerUrl:
    options.workerPath === null
      ? new URL('./worker-entry.mjs', import.meta.url)
      : pathToFileURL(path.resolve(options.workerPath)),
  onBackgroundError: (error) => backgroundErrors.push(error),
});

try {
  const initStartedAt = performance.now();
  await store.stats();
  const workerInitMs = performance.now() - initStartedAt;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
  const writes: Observation[] = [];
  const reads: number[] = [];
  let logicalInputBytes = 0;
  eventLoopDelay.enable();

  for (let turnIndex = 0; turnIndex < fixtures.length; turnIndex += 1) {
    const fixture = fixtures[turnIndex];
    if (!fixture) throw new Error(`Missing fixture ${turnIndex}.`);
    for (const event of fixture.events) {
      logicalInputBytes += Buffer.byteLength(event.oldText) + Buffer.byteLength(event.newText);
    }

    const writeStartedAt = performance.now();
    const headProof = await store.allocateHeadProof();
    const events = fixture.events.map((event) => ({
      ...event,
      newIsCurrent: true,
      headProof,
    }));
    const result = await store.recordTurn({
      ownerId: 'benchmark-session',
      turnId: fixture.turnId,
      capturedAtMs: 1_000 + turnIndex,
      recordedAtMs: 1_000 + turnIndex,
      events,
    });
    writes.push({
      roundTripMs: performance.now() - writeStartedAt,
      metrics: result.metrics,
    });

    const readStartedAt = performance.now();
    const snapshots = await Promise.all(
      fixture.events.map((event) =>
        store.getTurnSnapshot({
          ownerId: 'benchmark-session',
          turnId: fixture.turnId,
          path: event.path,
          nowMs: 1_000 + turnIndex,
        })
      )
    );
    reads.push(performance.now() - readStartedAt);
    for (let fileIndex = 0; fileIndex < fixture.events.length; fileIndex += 1) {
      const event = fixture.events[fileIndex];
      const snapshot = snapshots[fileIndex];
      if (!event || snapshot?.status !== 'ready') {
        throw new Error(`Snapshot ${fixture.turnId}/${event?.path ?? fileIndex} was unavailable.`);
      }
      if (snapshot.oldText !== event.oldText || snapshot.newText !== event.newText) {
        throw new Error(`Snapshot ${fixture.turnId}/${event.path} failed exact verification.`);
      }
    }
  }

  eventLoopDelay.disable();
  const stats = await store.stats();
  if (backgroundErrors.length > 0) throw backgroundErrors[0];
  const report = buildReport({
    options,
    workerInitMs,
    logicalInputBytes,
    writes,
    reads,
    stats,
    eventLoopDelayP99Ms: eventLoopDelay.percentile(99) / 1e6,
    eventLoopDelayMaxMs: eventLoopDelay.max / 1e6,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
} finally {
  await store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function createFixtures(benchmarkOptions: BenchmarkOptions): readonly TurnFixture[] {
  const current = Array.from({ length: benchmarkOptions.files }, (_, index) =>
    deterministicText(10_000 + index, benchmarkOptions.fileBytes)
  );
  const turnFixtures: TurnFixture[] = [];
  for (let turnIndex = 0; turnIndex < benchmarkOptions.turns; turnIndex += 1) {
    const events = current.map((oldText, fileIndex) => {
      const edit = deterministicText(
        1_000_000 + turnIndex * benchmarkOptions.files + fileIndex,
        benchmarkOptions.editBytes
      );
      const maxOffset = Math.max(1, oldText.length - benchmarkOptions.editBytes);
      const offset = (turnIndex * 7_919 + fileIndex * 104_729) % maxOffset;
      const newText = `${oldText.slice(0, offset)}${edit}${oldText.slice(
        Math.min(oldText.length, offset + benchmarkOptions.editBytes)
      )}`;
      current[fileIndex] = newText;
      return {
        path: `src/fixture-${fileIndex}.txt`,
        oldText,
        newText,
        add: 1,
        del: 1,
      };
    });
    turnFixtures.push({ turnId: `turn-${turnIndex}`, events });
  }
  return turnFixtures;
}

function deterministicText(seed: number, byteLength: number): string {
  const bytes = Buffer.allocUnsafe(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = state >>> 0;
    bytes[index] = index % 96 === 95 ? 10 : 32 + (value % 95);
  }
  return bytes.toString('ascii');
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  let json = false;
  for (const argument of args) {
    if (argument === '--') continue;
    if (argument === '--json') {
      json = true;
      continue;
    }
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(`Unknown benchmark argument ${argument}. Use --name=value.`);
    }
    values.set(match[1], match[2]);
  }
  const compression = values.get('codec') ?? 'gzip';
  if (compression !== 'zstd' && compression !== 'gzip') {
    throw new Error('--codec must be zstd or gzip.');
  }
  return {
    turns: positiveInteger(values.get('turns') ?? '20', 'turns'),
    files: positiveInteger(values.get('files') ?? '4', 'files'),
    fileBytes: positiveInteger(values.get('file-kib') ?? '256', 'file-kib') * 1024,
    editBytes: positiveInteger(values.get('edit-bytes') ?? '256', 'edit-bytes'),
    compression,
    workerPath: values.get('worker') ?? null,
    json,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function buildReport(input: {
  readonly options: BenchmarkOptions;
  readonly workerInitMs: number;
  readonly logicalInputBytes: number;
  readonly writes: readonly Observation[];
  readonly reads: readonly number[];
  readonly stats: TurnDiffStoreStats;
  readonly eventLoopDelayP99Ms: number;
  readonly eventLoopDelayMaxMs: number;
}) {
  const writeRoundTrips = input.writes.map((write) => write.roundTripMs);
  const metric = (key: keyof RecordTurnDiffMetrics) =>
    input.writes.map((write) => write.metrics[key]);
  return {
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      fastCdcProfile: FASTCDC_PROFILE_ID,
      compression: input.options.compression,
      worker: input.options.workerPath ?? 'package source via tsx',
    },
    workload: {
      turns: input.options.turns,
      filesPerTurn: input.options.files,
      fileBytes: input.options.fileBytes,
      editBytes: input.options.editBytes,
      logicalInputBytes: input.logicalInputBytes,
    },
    latencyMs: {
      workerInit: round(input.workerInitMs),
      recordRoundTrip: summarize(writeRoundTrips),
      recordWorkerTotal: summarize(metric('totalMs')),
      snapshotBatchRoundTrip: summarize(input.reads),
      phases: {
        encode: summarize(metric('encodeMs')),
        chunking: summarize(metric('chunkingMs')),
        hashing: summarize(metric('hashingMs')),
        compression: summarize(metric('compressionMs')),
        sqliteTransaction: summarize(metric('transactionMs')),
      },
      mainThreadEventLoopDelay: {
        p99: round(input.eventLoopDelayP99Ms),
        max: round(input.eventLoopDelayMaxMs),
      },
    },
    reuse: {
      newChunks: sum(metric('newChunks')),
      reusedChunks: sum(metric('reusedChunks')),
      uniqueRawChunkBytes: input.stats.rawChunkBytes,
      storedChunkBytes: input.stats.storedChunkBytes,
      logicalToStoredRatio: round(
        input.logicalInputBytes / Math.max(1, input.stats.storedChunkBytes)
      ),
    },
    sqlite: {
      turns: input.stats.turns,
      files: input.stats.files,
      snapshots: input.stats.snapshots,
      chunks: input.stats.chunks,
      storage: input.stats.storage,
      invalidSnapshotRefCounts: input.stats.invalidSnapshotRefCounts,
      invalidChunkRefCounts: input.stats.invalidChunkRefCounts,
      integrity: input.stats.integrity,
    },
  };
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(sum(values) / Math.max(1, values.length)),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function printHumanReport(report: ReturnType<typeof buildReport>): void {
  const write = report.latencyMs.recordRoundTrip;
  const read = report.latencyMs.snapshotBatchRoundTrip;
  console.log('Turn diff store end-to-end benchmark');
  console.log(
    `  workload: ${report.workload.turns} turns × ${report.workload.filesPerTurn} files × ${formatBytes(
      report.workload.fileBytes
    )}`
  );
  console.log(`  runtime: ${report.runtime.node}, ${report.runtime.fastCdcProfile}`);
  console.log(`  worker: ${report.runtime.worker}`);
  console.log(`  worker init: ${report.latencyMs.workerInit} ms`);
  console.log(`  record round trip: p50 ${write.p50} ms, p95 ${write.p95} ms, max ${write.max} ms`);
  console.log(
    `  load ${report.workload.filesPerTurn} exact pairs: p50 ${read.p50} ms, p95 ${read.p95} ms, max ${read.max} ms`
  );
  console.log(
    `  main event-loop delay: p99 ${report.latencyMs.mainThreadEventLoopDelay.p99} ms, max ${report.latencyMs.mainThreadEventLoopDelay.max} ms`
  );
  console.log(
    `  chunks: ${report.reuse.newChunks} new, ${report.reuse.reusedChunks} reused, logical/stored ${report.reuse.logicalToStoredRatio}×`
  );
  console.log(
    `  SQLite: ${formatBytes(report.sqlite.storage.total)}, integrity=${report.sqlite.integrity}, badRefs=${
      report.sqlite.invalidSnapshotRefCounts + report.sqlite.invalidChunkRefCounts
    }`
  );
  console.log('  use --json for phase-level metrics');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${round(bytes / 1024)} KiB`;
  return `${round(bytes / 1024 ** 2)} MiB`;
}
