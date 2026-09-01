import * as http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type { LocalSessionControlRequest } from '../src/message';
import {
  LOCAL_CONTROL_HEADER,
  LOCAL_IPC_MAX_RESPONSE_BODY_BYTES,
  LocalDaemonRunFileCorruptError,
  LocalDaemonRunFileMissingError,
  LocalDaemonRunFilePermissionError,
  IpcProtocolError,
  getLocalControlSocketPath,
  getLocalDaemonRunDir,
  getLocalProbeSocketPath,
  makeLocalControlClientAuto,
  makeLocalControlClientSocket,
  readLocalDaemonRunFile,
  writeLocalDaemonRunFile,
} from '../src/node/local-ipc';
import { getLocalTerminalSocketPath } from '../src/node/local-terminal';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function makeTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeSocketPath(name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\lody-test-${process.pid}-${randomUUID()}-${name}`;
  }
  return path.join(makeTempDir('lody-ipc-'), `${name}.sock`);
}

function listenSocket(socketPath: string, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const createSessionRequest = (): LocalSessionControlRequest => ({
  type: 'session/create',
  machineId: 'machine-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  acpSessionConfig: {
    prompt: 'hello',
    cliType: 'builtin',
    agentType: 'codex',
  },
  userId: 'user-1',
  userName: 'User One',
  userEmail: 'user@example.com',
});

describe('local IPC socket client', () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('posts local-control messages with the control header and parses responses', async () => {
    const socketPath = makeSocketPath('control');
    const request = createSessionRequest();
    const seen: string[] = [];
    await listenSocket(socketPath, (req, res) => {
      void (async () => {
        expect(req.url).toBe('/session-control');
        expect(req.method).toBe('POST');
        expect(req.headers[LOCAL_CONTROL_HEADER]).toBe('1');
        seen.push(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            responses: [
              {
                type: 'session/create_response',
                sessionId: 'session-1',
                success: true,
              },
            ],
          })
        );
      })();
    });

    await expect(
      Effect.runPromise(makeLocalControlClientSocket({ socketPath }).sessionControl(request))
    ).resolves.toEqual([
      {
        type: 'session/create_response',
        sessionId: 'session-1',
        success: true,
      },
    ]);
    expect(seen).toEqual([JSON.stringify(request)]);
  });

  it('maps malformed JSON responses to typed protocol errors', async () => {
    const socketPath = makeSocketPath('control');
    await listenSocket(socketPath, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json');
    });

    await expect(
      Effect.runPromise(
        Effect.flip(
          makeLocalControlClientSocket({ socketPath }).sessionControl(createSessionRequest())
        )
      )
    ).resolves.toBeInstanceOf(IpcProtocolError);
  });

  it('rejects oversized responses with a typed protocol error instead of buffering them', async () => {
    const socketPath = makeSocketPath('control');
    await listenSocket(socketPath, (_req, res) => {
      // Swallow write errors: the client destroys the connection mid-body once
      // the cap trips, which is exactly what this test provokes.
      res.on('error', () => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(Buffer.alloc(LOCAL_IPC_MAX_RESPONSE_BODY_BYTES + 1, 0x61));
    });

    const error = await Effect.runPromise(
      Effect.flip(
        makeLocalControlClientSocket({ socketPath }).sessionControl(createSessionRequest())
      )
    );
    expect(error).toBeInstanceOf(IpcProtocolError);
    expect(error.message).toContain(`exceeded ${LOCAL_IPC_MAX_RESPONSE_BODY_BYTES} bytes`);
  });

  it('auto control client is socket-only', async () => {
    await expect(
      Effect.runPromise(
        Effect.flip(
          makeLocalControlClientAuto({
            socketPath: makeSocketPath('missing-control'),
          }).sessionControl(createSessionRequest())
        )
      )
    ).resolves.toMatchObject({ _tag: 'IpcConnectError' });
  });

  it('writes and reads the daemon run-file atomically with private permissions', () => {
    const runFilePath = path.join(makeTempDir('lody-run-parent-'), 'run', 'daemon.json');
    const runFile = {
      pid: 123,
      socketPath: '/tmp/lody-probe-test.sock',
      controlSocketPath: '/tmp/lody-control-test.sock',
      version: '0.0.0-test',
      startedAt: '2026-06-29T00:00:00.000Z',
    };

    writeLocalDaemonRunFile(runFile, runFilePath);

    expect(readLocalDaemonRunFile(runFilePath)).toEqual(runFile);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(runFilePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(runFilePath).mode & 0o777).toBe(0o600);
    }
  });

  it('throws typed run-file errors for missing and corrupt files', () => {
    const tempDir = makeTempDir('lody-run-errors-');
    const missingPath = path.join(tempDir, 'missing.json');
    const corruptPath = path.join(tempDir, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{bad json', 'utf8');

    expect(() => readLocalDaemonRunFile(missingPath)).toThrow(LocalDaemonRunFileMissingError);
    expect(() => readLocalDaemonRunFile(corruptPath)).toThrow(LocalDaemonRunFileCorruptError);
  });

  it.skipIf(process.platform === 'win32')(
    'places default socket paths inside the private daemon run dir, not tmpdir',
    () => {
      const runDir = getLocalDaemonRunDir();
      expect(path.dirname(getLocalControlSocketPath())).toBe(runDir);
      expect(path.dirname(getLocalProbeSocketPath())).toBe(runDir);
      expect(path.dirname(getLocalTerminalSocketPath())).toBe(runDir);
      expect(runDir.startsWith(os.tmpdir())).toBe(false);
    }
  );

  it('keeps the CommonJS terminal socket path in sync with the TypeScript module', () => {
    const require = createRequire(import.meta.url);
    const cjs = require('../src/node/local-terminal.cjs') as {
      getLocalTerminalSocketPath: () => string;
    };
    expect(cjs.getLocalTerminalSocketPath()).toBe(getLocalTerminalSocketPath());
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws typed run-file errors for permission failures',
    () => {
      const tempDir = makeTempDir('lody-run-permission-');
      const deniedPath = path.join(tempDir, 'daemon.json');
      fs.writeFileSync(deniedPath, '{}', 'utf8');
      fs.chmodSync(deniedPath, 0o000);
      try {
        expect(() => readLocalDaemonRunFile(deniedPath)).toThrow(LocalDaemonRunFilePermissionError);
      } finally {
        fs.chmodSync(deniedPath, 0o600);
      }
    }
  );
});
