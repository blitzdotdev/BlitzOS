#!/usr/bin/node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const {spawn} = require('child_process');

const stateDir = '/var/lib/blitz';
const errorPath = path.join(stateDir, 'bootstrap-error.log');
// The image's own register oneshot wrapper. It is the ONE bounded way to run
// `blitz-cred register` on a box: it drops to the blitz account, points HOME
// and BLITZ_STATE_DIR at the state volume, and carries a `timeout 60` backstop
// over blitz-cred's own 45 s deadline — and it never exits nonzero on an
// enrolment failure, because a workspace that boots signed out beats one that
// never boots. This script adds no second timeout-and-kill stack on top: a
// kill from out here lands mid-write on the only copy of the box credential.
const registerWrapper = '/usr/local/libexec/blitz-register';

function decode(name) {
  const raw = process.env[name] || '';
  return raw ? Buffer.from(raw, 'base64url').toString('utf8') : '';
}

const phoneHomeURL = decode('BLITZ_MICROVM_PHONE_HOME_B64');
const cpOrigin = decode('BLITZ_MICROVM_CP_ORIGIN_B64');
const phoneHomeResponseFields = ['box_id', 'access_token', 'refresh_token'];
const phoneHomeIdentityFields = ['workspace_id', 'webapp_token'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHostKeys() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(stateDir, 'ssh'));
    } catch (_) {}
    const keys = names
      .filter((name) => /^ssh_host_.*_key\.pub$/.test(name))
      .sort()
      .map((name) => fs.readFileSync(path.join(stateDir, 'ssh', name), 'utf8').trim())
      .filter(Boolean);
    if (keys.length > 0) return keys;
    await sleep(20);
  }
  throw new Error('timed out waiting for SSH host public keys');
}

async function waitForSSHD() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({host: '127.0.0.1', port: 22});
      socket.setTimeout(250);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for sshd');
}

function request(rawURL, contentType, body) {
  const target = new URL(rawURL);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'POST',
      headers: {'content-type': contentType, 'content-length': Buffer.byteLength(body)},
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error('phone-home response exceeded 1 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.once('timeout', () => req.destroy(new Error('phone-home request timed out')));
    req.once('error', reject);
    req.end(body);
  });
}

function atomicWrite(filename, value, mode) {
  fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
  const temp = `${filename}.new.${process.pid}`;
  fs.writeFileSync(temp, value, {mode});
  fs.chmodSync(temp, mode);
  try { fs.chownSync(temp, 1000, 1000); } catch (_) {}
  fs.renameSync(temp, filename);
}

function storePhoneHomeResponse(stored, targetStateDir = stateDir) {
  const credential = {
    box_id: stored.box_id,
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
  };
  atomicWrite(path.join(targetStateDir, 'box-credential.json'), `${JSON.stringify(credential)}\n`, 0o600);
  if (stored.webapp_token) {
    atomicWrite(path.join(targetStateDir, 'webapp-token'), `${stored.webapp_token}\n`, 0o600);
    atomicWrite(path.join(targetStateDir, 'workspace-id'), `${stored.workspace_id}\n`, 0o600);
  }
}

function safeError(error) {
  return String(error && error.message ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function phoneHomeField(hostPublicKey) {
  const algorithm = hostPublicKey.trim().split(/\s+/, 1)[0] || '';
  if (algorithm.startsWith('ecdsa-')) return 'pub_key_ecdsa';
  if (algorithm === 'ssh-ed25519' || algorithm.startsWith('sk-ssh-ed25519')) return 'pub_key_ed25519';
  if (algorithm === 'ssh-rsa') return 'pub_key_rsa';
  return null;
}

function buildPhoneHomePayload(hostPublicKeys) {
  if (!Array.isArray(hostPublicKeys)) throw new TypeError('host public keys must be an array');
  const payload = {
    pub_key_ecdsa: '',
    pub_key_ed25519: '',
    pub_key_rsa: '',
  };
  for (const hostPublicKey of hostPublicKeys) {
    if (typeof hostPublicKey !== 'string') throw new TypeError('host public key must be a string');
    const field = phoneHomeField(hostPublicKey);
    if (field && payload[field] === '') payload[field] = hostPublicKey.trim();
  }
  return payload;
}

function buildPhoneHomeFailurePayload(message) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('bootstrap error must be a non-empty string');
  }
  return {bootstrap_error: message};
}

function parsePhoneHomeResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('phone-home response must be an object');
  }
  const fields = Object.keys(value).sort();
  const legacy = [...phoneHomeResponseFields].sort();
  const current = [...phoneHomeResponseFields, ...phoneHomeIdentityFields].sort();
  const exactLegacy = fields.length === legacy.length && fields.every((field, index) => field === legacy[index]);
  const exactCurrent = fields.length === current.length && fields.every((field, index) => field === current[index]);
  if (!exactLegacy && !exactCurrent) {
    throw new Error('phone-home response fields are invalid');
  }
  for (const field of phoneHomeResponseFields) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`phone-home response omitted ${field}`);
    }
  }
  const response = {
    box_id: value.box_id,
    access_token: value.access_token,
    refresh_token: value.refresh_token,
  };
  if (exactCurrent) {
    for (const field of phoneHomeIdentityFields) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary validation for the optional phone-home revision fields.
      if (typeof value[field] !== 'string' || value[field].length === 0) {
        throw new Error(`phone-home response omitted ${field}`);
      }
    }
    response.workspace_id = value.workspace_id;
    response.webapp_token = value.webapp_token;
  }
  return response;
}

async function pokeRegister() {
  process.stdout.write('microvm-enroll: register start\n');
  await new Promise((resolve) => {
    let settled = false;
    const finish = (message, failed) => {
      if (settled) return;
      settled = true;
      (failed ? process.stderr : process.stdout).write(`microvm-enroll: ${message}\n`);
      resolve();
    };
    let child;
    try {
      // Root on purpose: the wrapper does its own s6-setuidgid drop to the
      // blitz account, exactly as it does under the s6 register oneshot.
      // Inherited stdio lands the wrapper's output in microvm-enroll.log.
      child = spawn(registerWrapper, [], {stdio: ['ignore', 'inherit', 'inherit']});
    } catch (error) {
      finish(`register failed: ${safeError(error)}`, true);
      return;
    }
    child.once('error', (error) => {
      finish(`register failed: ${safeError(error)}`, true);
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish('register complete', false);
        return;
      }
      finish(`register failed: exit_code=${code === null ? 'none' : code} signal=${signal || 'none'}`, true);
    });
  });
}

async function reportFailure(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  atomicWrite(errorPath, line, 0o600);
  const payload = JSON.stringify(buildPhoneHomeFailurePayload(message));
  try {
    await request(phoneHomeURL, 'application/json', payload);
  } catch (error) {
    fs.appendFileSync(errorPath, `${new Date().toISOString()} failure-report: ${safeError(error)}\n`);
  }
}

async function main() {
  if (!phoneHomeURL) throw new Error('missing phone-home URL');
  const hostPublicKeys = await waitForHostKeys();
  await waitForSSHD();
  const payload = JSON.stringify(buildPhoneHomePayload(hostPublicKeys));
  const response = await request(phoneHomeURL, 'application/json', payload);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`phone-home returned HTTP ${response.status}`);
  }
  let responseValue;
  try {
    responseValue = JSON.parse(response.body);
  } catch (_) {
    throw new Error('phone-home returned invalid JSON');
  }
  const stored = parsePhoneHomeResponse(responseValue);
  storePhoneHomeResponse(stored);
  atomicWrite(path.join(stateDir, 'origin'), `${cpOrigin}\n`, 0o644);
  await pokeRegister();
  process.stdout.write(`microvm-enroll: complete host_key_count=${hostPublicKeys.length}\n`);
}

module.exports = {
  buildPhoneHomeFailurePayload,
  buildPhoneHomePayload,
  parsePhoneHomeResponse,
  storePhoneHomeResponse,
};

if (require.main === module) {
  main().catch(async (error) => {
    const message = safeError(error);
    await reportFailure(message);
    process.stderr.write(`microvm-enroll: failed: ${message}\n`);
    process.exitCode = 1;
  });
}
