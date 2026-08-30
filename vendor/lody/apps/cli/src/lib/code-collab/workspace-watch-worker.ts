import { startWorkspaceWatchWorker } from './workspace-watch-worker-core';

startWorkspaceWatchWorker({
  send: (message) => process.send?.(message),
  onMessage: (handler) => process.on('message', handler),
  onDisconnect: (handler) => process.on('disconnect', handler),
  exit: () => {
    process.exitCode = 0;
    if (process.connected) process.disconnect?.();
  },
});
