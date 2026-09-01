const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { getInstallationProfile, getLodyDataDir } = require('./installation-profile.cjs');

// Keep this file in sync with local-terminal.ts (which delegates to
// local-ipc.ts getLocalDaemonSocketPath — mirrored here because no CommonJS
// build of local-ipc exists). Electron main consumes this CommonJS export
// while the CLI daemon consumes the TypeScript module.

// sockaddr_un.sun_path is ~104 bytes on macOS and 108 on Linux, including the
// trailing NUL; binding a longer path fails at the OS level.
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function getUserSocketSuffix() {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  const userInfo = os.userInfo();
  return crypto
    .createHash('sha256')
    .update(`${userInfo.uid}:${userInfo.username}:${os.homedir()}`)
    .digest('hex')
    .slice(0, 16);
}

function getLocalTerminalSocketPath(platform) {
  const basename = `${getInstallationProfile(platform).namespace}-terminal`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${basename}-${getUserSocketSuffix()}`;
  }

  // Same 0700 run dir as the control/probe sockets — never a world-writable
  // shared tmpdir, so other local users cannot squat or symlink the
  // well-known path (S1).
  const socketPath = path.join(getLodyDataDir(platform), 'run', `${basename}.sock`);
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`local_ipc_socket_path_too_long:${socketPath}`);
  }
  return socketPath;
}

module.exports = {
  getLocalTerminalSocketPath,
};
