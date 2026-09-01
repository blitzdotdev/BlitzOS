import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStaleUnixSocket, socketPathExistsAsSocket } from '../src/lib/stale-unix-socket';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-stale-socket-'));
  tempDirs.push(tempDir);
  return tempDir;
}

// Leave a real socket *file* behind with no listener: bind elsewhere, rename
// the live socket file onto the target path, then close the listener.
async function plantStaleSocketFile(socketPath: string): Promise<void> {
  const stagingPath = `${socketPath}.orig`;
  const staleServer = net.createServer();
  await new Promise<void>((resolve, reject) => {
    staleServer.once('error', reject);
    staleServer.listen(stagingPath, resolve);
  });
  fs.renameSync(stagingPath, socketPath);
  await new Promise<void>((resolve) => staleServer.close(() => resolve()));
}

describe.skipIf(process.platform === 'win32')('stale unix socket cleanup', () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the socket path does not exist', async () => {
    const socketPath = path.join(makeTempDir(), 'missing.sock');
    await expect(removeStaleUnixSocket(socketPath, 'test_in_use')).resolves.toBeUndefined();
  });

  it('unlinks a stale socket file left behind by a dead process', async () => {
    const socketPath = path.join(makeTempDir(), 'stale.sock');
    await plantStaleSocketFile(socketPath);
    expect(socketPathExistsAsSocket(socketPath)).toBe(true);

    await removeStaleUnixSocket(socketPath, 'test_in_use');

    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('refuses to unlink a planted regular file at the socket path', async () => {
    const socketPath = path.join(makeTempDir(), 'planted.sock');
    fs.writeFileSync(socketPath, 'planted');

    await expect(removeStaleUnixSocket(socketPath, 'test_in_use')).rejects.toThrow(
      /local_ipc_socket_path_not_socket/
    );
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('planted');
  });

  it('refuses to unlink a planted symlink at the socket path', async () => {
    const tempDir = makeTempDir();
    const targetPath = path.join(tempDir, 'symlink-target');
    const socketPath = path.join(tempDir, 'link.sock');
    fs.writeFileSync(targetPath, 'target');
    fs.symlinkSync(targetPath, socketPath);

    await expect(removeStaleUnixSocket(socketPath, 'test_in_use')).rejects.toThrow(
      /local_ipc_socket_path_not_socket/
    );
    expect(fs.lstatSync(socketPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('target');
  });

  it('reports a live listener as in use with the caller error code', async () => {
    const socketPath = path.join(makeTempDir(), 'live.sock');
    const liveServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      liveServer.once('error', reject);
      liveServer.listen(socketPath, resolve);
    });

    try {
      await expect(removeStaleUnixSocket(socketPath, 'test_in_use')).rejects.toThrow(
        new RegExp(`test_in_use:${socketPath.replaceAll('.', '\\.')}`)
      );
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    }
  }, 10_000);
});
