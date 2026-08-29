import { createWriteStream } from 'node:fs';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { open as openYauzl, type Entry, type RandomAccessReader, type ZipFile } from 'yauzl';

type OpenZip = (
  path: string,
  options: {
    autoClose: boolean;
    lazyEntries: boolean;
    strictFileNames: boolean;
  },
  callback: (error: Error | null, zipFile: ZipFile) => void
) => void;

type CreateEntryWriteStream = (path: string, options: { mode: number }) => Writable;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('ZIP extraction was cancelled', 'AbortError');
}

function isInside(rootDir: string, candidate: string): boolean {
  const pathFromRoot = relative(rootDir, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function extractedMode(entryMode: number, isDirectory: boolean): number {
  const mode = entryMode & 0o777;
  return mode || (isDirectory ? 0o755 : 0o644);
}

function entryKind(entry: Entry): {
  isDirectory: boolean;
  isSymlink: boolean;
  mode: number;
} {
  const entryMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = entryMode & 0o170000;
  const isSymlink = fileType === 0o120000;
  let isDirectory = fileType === 0o040000 || entry.fileName.endsWith('/');

  // Some Windows ZIP writers only set the DOS directory attribute.
  const madeBy = entry.versionMadeBy >>> 8;
  if (!isDirectory && madeBy === 0 && entry.externalFileAttributes === 16) {
    isDirectory = true;
  }
  return {
    isDirectory,
    isSymlink,
    mode: extractedMode(entryMode, isDirectory),
  };
}

async function openZip(path: string, implementation: OpenZip): Promise<ZipFile> {
  return await new Promise<ZipFile>((resolveZip, reject) => {
    implementation(
      path,
      { autoClose: false, lazyEntries: true, strictFileNames: true },
      (error, zipFile) => {
        if (error) {
          reject(error);
          return;
        }
        resolveZip(zipFile);
      }
    );
  });
}

async function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return await new Promise<Readable>((resolveStream, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolveStream(stream);
    });
  });
}

function relayEntryStream(
  source: Readable,
  signal: AbortSignal
): { stream: Readable; cleanup: () => void } {
  const relay = new PassThrough();
  const handleError = (error: Error): void => {
    relay.destroy(error);
  };
  const handleAbort = (): void => {
    source.unpipe(relay);
    // yauzl's deflated-entry destroy() releases its reader ref but does not
    // settle the endpoint itself. The relay is the stream our consumer awaits.
    source.destroy();
    relay.destroy();
  };
  source.on('error', handleError);
  source.pipe(relay);
  signal.addEventListener('abort', handleAbort, { once: true });
  if (signal.aborted) handleAbort();

  return {
    stream: relay,
    cleanup: () => {
      signal.removeEventListener('abort', handleAbort);
      source.off('error', handleError);
      source.unpipe(relay);
      if (!source.readableEnded) source.destroy();
      if (!relay.destroyed) relay.destroy();
    },
  };
}

function waitForZipReaderClose(zipFile: ZipFile): Promise<void> {
  const reader = (zipFile as ZipFile & { reader: RandomAccessReader }).reader;
  return new Promise<void>((resolveClosed, rejectClosed) => {
    // yauzl forwards reader errors to ZipFile. Keep an error listener present
    // even before extraction listeners are installed so close EIO cannot turn
    // into an uncaught EventEmitter error.
    const handleForwardedError = (): void => undefined;
    const cleanup = (): void => {
      zipFile.off('error', handleForwardedError);
      reader.off('close', handleClose);
      reader.off('error', handleError);
    };
    const handleClose = (): void => {
      cleanup();
      resolveClosed();
    };
    const handleError = (error: Error): void => {
      cleanup();
      rejectClosed(error);
    };

    zipFile.on('error', handleForwardedError);
    reader.once('close', handleClose);
    reader.once('error', handleError);
  });
}

async function extractEntry(
  zipFile: ZipFile,
  entry: Entry,
  rootDir: string,
  signal: AbortSignal,
  setActiveStream: (stream: Readable | undefined) => void,
  createEntryWriteStream: CreateEntryWriteStream
): Promise<void> {
  signal.throwIfAborted();
  if (entry.fileName.startsWith('__MACOSX/')) return;

  const destination = resolve(rootDir, entry.fileName);
  if (!isInside(rootDir, destination)) {
    throw new Error(`Out of bound path found while processing ZIP entry ${entry.fileName}`);
  }

  const { isDirectory, isSymlink, mode } = entryKind(entry);
  const destinationDir = isDirectory ? destination : dirname(destination);
  await mkdir(destinationDir, { recursive: true, ...(isDirectory ? { mode } : {}) });

  // A prior symlink entry could otherwise redirect a later entry outside the
  // extraction root even when its lexical path looks safe.
  const canonicalDestinationDir = await realpath(destinationDir);
  if (!isInside(rootDir, canonicalDestinationDir)) {
    throw new Error(`Out of bound path found while processing ZIP entry ${entry.fileName}`);
  }
  signal.throwIfAborted();
  if (isDirectory) return;

  const readStream = await openEntryStream(zipFile, entry);
  setActiveStream(readStream);
  const relayed = relayEntryStream(readStream, signal);
  try {
    signal.throwIfAborted();
    if (isSymlink) {
      const chunks: Buffer[] = [];
      for await (const chunk of relayed.stream) {
        signal.throwIfAborted();
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      signal.throwIfAborted();
      await symlink(Buffer.concat(chunks).toString(), destination);
      return;
    }

    await pipeline(relayed.stream, createEntryWriteStream(destination, { mode }), { signal });
  } finally {
    relayed.cleanup();
    setActiveStream(undefined);
  }
}

/**
 * Extract a ZIP one entry at a time. Unlike `extract-zip`, the active yauzl
 * read stream is owned here, so an AbortSignal can stop the current large file
 * immediately instead of merely preventing the next entry from starting.
 */
export async function extractAbortableZip(
  archivePath: string,
  destinationDir: string,
  signal: AbortSignal,
  openZipImplementation: OpenZip = openYauzl,
  createEntryWriteStream: CreateEntryWriteStream = (path, options) =>
    createWriteStream(path, options)
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(destinationDir, { recursive: true });
  const rootDir = await realpath(destinationDir);
  const zipFile = await openZip(archivePath, openZipImplementation);
  const zipClosed = waitForZipReaderClose(zipFile);
  const zipClosedOutcome = zipClosed.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );

  if (signal.aborted) {
    zipFile.close();
    const closeOutcome = await zipClosedOutcome;
    if (!closeOutcome.ok) throw closeOutcome.error;
    signal.throwIfAborted();
  }

  await new Promise<void>((resolveExtraction, rejectExtraction) => {
    let outcome: { kind: 'success' } | { kind: 'failure'; error: unknown } | undefined;
    let activeStream: Readable | undefined;
    let activeTask: Promise<void> | undefined;

    const cleanup = (): void => {
      signal.removeEventListener('abort', handleAbort);
      zipFile.off('entry', handleEntry);
      zipFile.off('error', handleError);
      zipFile.off('end', handleEnd);
    };
    const settleAfterQuiescence = (): void => {
      void (async () => {
        const [, closeOutcome] = await Promise.all([
          activeTask?.catch(() => undefined),
          zipClosedOutcome,
        ]);
        cleanup();
        if (outcome?.kind === 'failure') {
          rejectExtraction(outcome.error);
          return;
        }
        if (!closeOutcome.ok) {
          rejectExtraction(closeOutcome.error);
          return;
        }
        resolveExtraction();
      })();
    };
    const closeZip = (): void => {
      if (zipFile.isOpen) zipFile.close();
    };
    const fail = (error: unknown): void => {
      if (outcome) return;
      outcome = { kind: 'failure', error };
      signal.removeEventListener('abort', handleAbort);
      zipFile.off('entry', handleEntry);
      zipFile.off('end', handleEnd);
      // Keep the error listener until the active entry and reader have both
      // closed. A metadata read can still emit after close() starts.
      // This may run before pipeline has installed an error listener.
      activeStream?.destroy();
      closeZip();
      settleAfterQuiescence();
    };
    const handleAbort = (): void => fail(abortError(signal));
    const handleError = (error: Error): void => fail(error);
    const handleEnd = (): void => {
      if (outcome) return;
      outcome = { kind: 'success' };
      signal.removeEventListener('abort', handleAbort);
      closeZip();
      settleAfterQuiescence();
    };
    const handleEntry = (entry: Entry): void => {
      const task = extractEntry(
        zipFile,
        entry,
        rootDir,
        signal,
        (stream) => {
          activeStream = stream;
        },
        createEntryWriteStream
      );
      activeTask = task;
      void task.then(
        () => {
          if (activeTask === task) activeTask = undefined;
          if (!outcome) zipFile.readEntry();
        },
        (error: unknown) => fail(error)
      );
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    zipFile.on('entry', handleEntry);
    zipFile.on('error', handleError);
    zipFile.on('end', handleEnd);
    zipFile.readEntry();
  });
}
