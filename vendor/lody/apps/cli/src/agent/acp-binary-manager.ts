import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  getRegistryAcpLaunchKind,
  type RegistryAcpAgent,
  type RegistryBinaryEntry,
} from '@lody/shared';
import * as tar from 'tar';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { extractAbortableZip } from './abortable-zip';
import { formatErrorWithCauses } from '@/utils/format-error';

/**
 * Resolves and caches `binary`-distribution ACP agents: download the
 * platform-specific archive, unpack it, and expose the executable. Agents that
 * also ship npx/uvx/local launchers never reach here — `binary` is the lowest
 * launch priority (see `getRegistryAcpLaunchKind`), so we only pay the download
 * cost when there is genuinely no package-manager alternative.
 *
 * Cache layout below the active installation data root:
 *   acp-bin/<id>/<version>/<platform-arch>/        unpacked artifact
 *   acp-bin/<id>/<version>/<platform-arch>/.lody-complete   ready marker
 *
 * Writes are atomic: download + unpack happen in a scratch dir, the result is
 * `rename`d into place only after the executable is verified, then the marker
 * is written. A crash mid-download therefore never leaves a half-unpacked dir
 * that `getBinaryStatus` would mistake for "installed".
 */

const COMPLETE_MARKER = '.lody-complete';

export type FetchImpl = (
  url: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  body: NodeReadableStream<Uint8Array> | null;
}>;

export interface AcpBinaryManagerOptions {
  /** Cache root; defaults to `<active installation data root>/acp-bin`. */
  rootDir?: string;
  /** HTTP fetcher; defaults to global `fetch`. Injected in tests. */
  fetchImpl?: FetchImpl;
  /** Current platform/arch override, for tests. */
  platform?: NodeJS.Platform;
  arch?: string;
}

export type AcpBinaryStatus =
  | { kind: 'not-applicable' }
  | { kind: 'unsupported-platform'; platformArch: string }
  | { kind: 'not-installed'; platformArch: string }
  | { kind: 'installed'; platformArch: string; command: string };

export interface ResolvedBinaryLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type EnsureAcpBinaryOptions = {
  signal?: AbortSignal;
};

type AcpBinaryInstallEntry = {
  consumers: Set<object>;
  controller: AbortController;
  promise: Promise<ResolvedBinaryLaunch>;
  settled: boolean;
};

export class AcpBinaryUnsupportedPlatformError extends Error {
  readonly platformArch: string;
  constructor(agentId: string, platformArch: string) {
    super(`ACP agent '${agentId}' has no binary for this platform (${platformArch})`);
    this.name = 'AcpBinaryUnsupportedPlatformError';
    this.platformArch = platformArch;
  }
}

export class AcpBinaryDownloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AcpBinaryDownloadError';
  }
}

/**
 * Map Node's `process.platform`/`process.arch` to the registry's
 * `<platform>-<arch>` key convention (e.g. `darwin-aarch64`). Returns
 * `undefined` for combinations the registry never uses.
 */
export function mapPlatformArch(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  const platformPart =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : undefined;
  const archPart = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!platformPart || !archPart) return undefined;
  return `${platformPart}-${archPart}`;
}

function sanitizeSegment(segment: string): string {
  // Defense-in-depth against `..`/separators sneaking into a cache path from
  // registry-controlled id/version strings.
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

type ArchiveKind = 'tar.gz' | 'zip' | 'raw';

function detectArchiveKind(archiveUrl: string): ArchiveKind {
  const path = (archiveUrl.split('?')[0] ?? '').toLowerCase();
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'tar.gz';
  if (path.endsWith('.zip')) return 'zip';
  // Everything else (raw binaries, plain `.exe`) is downloaded as-is and saved
  // under the `cmd` basename.
  return 'raw';
}

export class AcpBinaryManager {
  private readonly rootDir: string;
  private readonly fetchImpl: FetchImpl;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  /** Dedupe concurrent ensures of the same target dir to a single download. */
  private readonly inFlight = new Map<string, AcpBinaryInstallEntry>();

  constructor(options: AcpBinaryManagerOptions = {}) {
    this.rootDir = options.rootDir ?? join(getLodyDataDir(), 'acp-bin');
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchImpl>);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  /** `<id>/<version>/<platform-arch>` cache dir for an agent. */
  private targetDir(agentId: string, version: string, platformArch: string): string {
    return join(
      this.rootDir,
      sanitizeSegment(agentId),
      sanitizeSegment(version),
      sanitizeSegment(platformArch)
    );
  }

  private resolveEntry(
    agent: RegistryAcpAgent
  ):
    | { platformArch: string; entry: RegistryBinaryEntry }
    | { unsupported: true; platformArch: string } {
    const platformArch =
      mapPlatformArch(this.platform, this.arch) ?? `${this.platform}-${this.arch}`;
    const entry = agent.distribution.binary?.[platformArch];
    if (!entry) return { unsupported: true, platformArch };
    return { platformArch, entry };
  }

  /**
   * Inspect the local cache without downloading. `not-applicable` means the
   * agent does not launch via a binary at all (npx/uvx/local takes priority).
   */
  async getBinaryStatus(agent: RegistryAcpAgent): Promise<AcpBinaryStatus> {
    if (getRegistryAcpLaunchKind(agent.distribution) !== 'binary') {
      return { kind: 'not-applicable' };
    }
    const resolved = this.resolveEntry(agent);
    if ('unsupported' in resolved) {
      return { kind: 'unsupported-platform', platformArch: resolved.platformArch };
    }
    const dir = this.targetDir(agent.id, agent.version, resolved.platformArch);
    if (existsSync(join(dir, COMPLETE_MARKER))) {
      return {
        kind: 'installed',
        platformArch: resolved.platformArch,
        command: resolve(dir, resolved.entry.cmd),
      };
    }
    return { kind: 'not-installed', platformArch: resolved.platformArch };
  }

  /**
   * Ensure the agent's binary is downloaded and unpacked, returning its launch
   * command/args/env. Idempotent: a cache hit returns immediately; concurrent
   * callers for the same target share one download.
   */
  async ensureBinary(
    agent: RegistryAcpAgent,
    options: EnsureAcpBinaryOptions = {}
  ): Promise<ResolvedBinaryLaunch> {
    options.signal?.throwIfAborted();
    const resolved = this.resolveEntry(agent);
    if ('unsupported' in resolved) {
      throw new AcpBinaryUnsupportedPlatformError(agent.id, resolved.platformArch);
    }
    const { entry, platformArch } = resolved;
    const dir = this.targetDir(agent.id, agent.version, platformArch);

    if (existsSync(join(dir, COMPLETE_MARKER))) {
      return this.launchFor(dir, entry);
    }

    let install = this.inFlight.get(dir);
    if (install?.controller.signal.aborted) {
      await this.waitForCancelledInstallCleanup(install, options.signal);
      return await this.ensureBinary(agent, options);
    }
    if (!install) {
      const controller = new AbortController();
      let nextInstall!: AcpBinaryInstallEntry;
      const promise = this.downloadAndPublish(agent, entry, dir, controller.signal).finally(() => {
        nextInstall.settled = true;
        if (this.inFlight.get(dir) === nextInstall) {
          this.inFlight.delete(dir);
        }
      });
      nextInstall = {
        consumers: new Set(),
        controller,
        promise,
        settled: false,
      };
      this.inFlight.set(dir, nextInstall);
      install = nextInstall;
    }
    return await this.waitForInstall(install, options.signal);
  }

  private async waitForCancelledInstallCleanup(
    entry: AcpBinaryInstallEntry,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (!signal) {
      await entry.promise.catch(() => undefined);
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((completeCleanup, reject) => {
      const handleAbort = () => {
        cleanup();
        reject(new DOMException('ACP binary installation was cancelled', 'AbortError'));
      };
      const cleanup = () => signal.removeEventListener('abort', handleAbort);
      signal.addEventListener('abort', handleAbort, { once: true });
      void entry.promise.then(
        () => {
          cleanup();
          completeCleanup();
        },
        () => {
          cleanup();
          completeCleanup();
        }
      );
    });
  }

  private async waitForInstall(
    entry: AcpBinaryInstallEntry,
    signal: AbortSignal | undefined
  ): Promise<ResolvedBinaryLaunch> {
    signal?.throwIfAborted();
    const consumer = {};
    entry.consumers.add(consumer);
    return await new Promise<ResolvedBinaryLaunch>((completeInstall, reject) => {
      let finished = false;
      const release = (): void => {
        signal?.removeEventListener('abort', handleAbort);
        entry.consumers.delete(consumer);
        if (!entry.settled && entry.consumers.size === 0) {
          entry.controller.abort();
        }
      };
      const finish = (complete: () => void): void => {
        if (finished) return;
        finished = true;
        release();
        complete();
      };
      const handleAbort = (): void =>
        finish(() =>
          reject(new DOMException('ACP binary installation was cancelled', 'AbortError'))
        );

      signal?.addEventListener('abort', handleAbort, { once: true });
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      void entry.promise.then(
        (launch) => finish(() => completeInstall(launch)),
        (error: unknown) => finish(() => reject(error))
      );
    });
  }

  private launchFor(dir: string, entry: RegistryBinaryEntry): ResolvedBinaryLaunch {
    return {
      command: resolve(dir, entry.cmd),
      args: entry.args ?? [],
      env: entry.env,
    };
  }

  private async downloadAndPublish(
    agent: RegistryAcpAgent,
    entry: RegistryBinaryEntry,
    dir: string,
    signal: AbortSignal
  ): Promise<ResolvedBinaryLaunch> {
    signal.throwIfAborted();
    await mkdir(this.rootDir, { recursive: true });
    const scratch = await mkdtemp(join(this.rootDir, 'tmp-'));
    const artifactPath = join(scratch, 'artifact');
    const unpackDir = join(scratch, 'unpack');
    try {
      await mkdir(unpackDir, { recursive: true });
      await this.download(entry.archive, artifactPath, signal);
      signal.throwIfAborted();
      await this.unpack(entry, artifactPath, unpackDir, signal);
      signal.throwIfAborted();

      const cmdPath = resolve(unpackDir, entry.cmd);
      if (!existsSync(cmdPath)) {
        throw new AcpBinaryDownloadError(
          `Executable '${entry.cmd}' not found after unpacking ${agent.id}`
        );
      }
      if (this.platform !== 'win32') {
        await chmod(cmdPath, 0o755);
      }

      signal.throwIfAborted();
      await this.publish(unpackDir, dir);
      signal.throwIfAborted();
      // Marker last: its presence is the sole "installed" signal.
      await writeFile(join(dir, COMPLETE_MARKER), '');
      signal.throwIfAborted();
      return this.launchFor(dir, entry);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async download(url: string, dest: string, signal: AbortSignal): Promise<void> {
    let response: Awaited<ReturnType<FetchImpl>>;
    try {
      response = await this.fetchImpl(url, { signal });
    } catch (error) {
      if (signal.aborted) {
        throw (
          signal.reason ?? new DOMException('ACP binary installation was cancelled', 'AbortError')
        );
      }
      throw new AcpBinaryDownloadError(`Failed to fetch ${url}: ${formatErrorWithCauses(error)}`, {
        cause: error,
      });
    }
    if (!response.ok || !response.body) {
      throw new AcpBinaryDownloadError(`Failed to download ${url} (HTTP ${response.status})`);
    }
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(dest), { signal });
    } catch (error) {
      if (signal.aborted) {
        throw (
          signal.reason ?? new DOMException('ACP binary installation was cancelled', 'AbortError')
        );
      }
      throw new AcpBinaryDownloadError(`Failed to stream ${url}: ${formatErrorWithCauses(error)}`, {
        cause: error,
      });
    }
  }

  private async unpack(
    entry: RegistryBinaryEntry,
    artifactPath: string,
    unpackDir: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    const kind = detectArchiveKind(entry.archive);
    if (kind === 'tar.gz') {
      await pipeline(createReadStream(artifactPath), tar.x({ cwd: unpackDir }), { signal });
      return;
    }
    if (kind === 'zip') {
      await extractAbortableZip(artifactPath, unpackDir, signal);
      return;
    }
    // Raw binary: place it where `cmd` expects it.
    signal.throwIfAborted();
    const target = join(unpackDir, basename(entry.cmd));
    await rename(artifactPath, target);
  }

  /** Atomically move `unpackDir` into the final `dir`, replacing any stale dir. */
  private async publish(unpackDir: string, dir: string): Promise<void> {
    const parent = join(dir, '..');
    await mkdir(parent, { recursive: true });
    if (existsSync(dir)) {
      // A previous incomplete attempt (no marker) — replace it.
      await rm(dir, { recursive: true, force: true });
    }
    try {
      await rename(unpackDir, dir);
    } catch (error) {
      // Lost a publish race: another caller may have finished first.
      if (existsSync(join(dir, COMPLETE_MARKER))) return;
      // The directory now exists from a concurrent unpack — keep it if usable,
      // otherwise surface the rename failure.
      if (!existsSync(dir)) {
        throw error;
      }
    }
  }
}

/** Process-wide manager used by the production launch/install paths. */
let sharedManager: AcpBinaryManager | undefined;

export function getAcpBinaryManager(): AcpBinaryManager {
  if (!sharedManager) sharedManager = new AcpBinaryManager();
  return sharedManager;
}
