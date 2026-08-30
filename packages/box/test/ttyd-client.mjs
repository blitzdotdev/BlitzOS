import { openWebSocket } from './ws-client.mjs';

const url = process.env.TTYD_URL;
const input = process.env.TTYD_INPUT ?? '';
if (!url) throw new Error('TTYD_URL is required');

let sawOutput = false;
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`ttyd timeout: ${url}`)), 5000);
  openWebSocket(url, {
    origin: 'http://127.0.0.1:7443',
    protocols: ['tty'],
    onMessage: () => {
      sawOutput = true;
    },
    onClose: () => {
      clearTimeout(timeout);
      if (sawOutput) resolve();
      else reject(new Error(`ttyd returned no output: ${url}`));
    },
  }).then((socket) => {
    socket.send(Buffer.from(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 })));
    if (input) {
      setTimeout(() => socket.send(Buffer.concat([Buffer.from('0'), Buffer.from(input)])), 250);
    }
    setTimeout(() => socket.close(), 900);
  }, reject);
});
