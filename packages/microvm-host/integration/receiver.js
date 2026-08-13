#!/usr/bin/node
'use strict';

const fs = require('fs');
const http = require('http');

const port = Number(process.argv[2] || 39123);
const logPath = process.argv[3];
if (!logPath || !Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write('usage: receiver.js PORT LOG_PATH\n');
  process.exit(2);
}

fs.writeFileSync(logPath, '', {mode: 0o600});
fs.chmodSync(logPath, 0o600);

function record(event) {
  fs.appendFileSync(logPath, `${JSON.stringify({at: new Date().toISOString(), ...event})}\n`);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/enroll') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if ((req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(body);
      record({status: 'bootstrap_error', path: req.url, workspace_id: form.get('workspace_id') || '', has_error: form.has('bootstrap_error')});
      res.writeHead(204).end();
      return;
    }
    try {
      const payload = JSON.parse(body);
      const keys = Array.isArray(payload.host_public_keys) ? payload.host_public_keys : [];
      if (keys.length === 0 || keys.some((key) => typeof key !== 'string' || !key.startsWith('ssh-'))) {
        throw new Error('missing host public keys');
      }
      record({
        status: 'enrolled', path: req.url, workspace_id: payload.workspace_id || '',
        key_count: keys.length, key_algorithms: keys.map((key) => key.split(' ', 1)[0]),
      });
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({box_id: 'box-m2-integration', access_token: 'integration-access-token', refresh_token: 'integration-refresh-token'}));
    } catch (error) {
      record({status: 'bad_request', path: req.url, error: String(error.message).slice(0, 200)});
      res.writeHead(400, {'content-type': 'application/json'}).end('{"error":"bad request"}\n');
    }
  });
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`receiver-ready port=${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
