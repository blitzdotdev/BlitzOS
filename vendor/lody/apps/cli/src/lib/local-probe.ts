import type * as http from 'http';
import * as os from 'os';
import type { CliRuntimeState, MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

export interface LocalProbeConfig {
  machineId: MachineId;
  cliVersion: string;
  logger: Logger;
  getRuntimeState: () => CliRuntimeState;
}

export function createLocalProbeRequestHandler(config: LocalProbeConfig): http.RequestListener {
  const responseBody = JSON.stringify({
    ok: true,
    machineId: config.machineId,
    pid: process.pid,
    cliVersion: config.cliVersion,
    homeDir: os.homedir(),
  });

  return (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseBody);
      return;
    }

    if (req.method === 'GET' && req.url === '/state') {
      try {
        const state = config.getRuntimeState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (error) {
        const message = formatErrorMessage(error);
        config.logger.debug(`Failed to read runtime state for local probe: ${message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'state_unavailable',
            message,
          })
        );
      }
      return;
    }

    res.writeHead(404);
    res.end();
  };
}
