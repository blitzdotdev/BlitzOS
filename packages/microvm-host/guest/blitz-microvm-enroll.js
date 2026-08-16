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
const registerTimeoutMs = 30000;
const registerKillGraceMs = 5000;

function decode(name) {
  const raw = process.env[name] || '';
  return raw ? Buffer.from(raw, 'base64url').toString('utf8') : '';
}

const phoneHomeURL = decode('BLITZ_MICROVM_PHONE_HOME_B64');
const cpOrigin = decode('BLITZ_MICROVM_CP_ORIGIN_B64');
const phoneHomeResponseFields = ['box_id', 'access_token', 'refresh_token'];

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
  fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
  const temp = `${filename}.new.${process.pid}`;
  fs.writeFileSync(temp, value, {mode});
  fs.chmodSync(temp, mode);
  try { fs.chownSync(temp, 1000, 1000); } catch (_) {}
  fs.renameSync(temp, filename);
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
  const expected = [...phoneHomeResponseFields].sort();
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error('phone-home response fields are invalid');
  }
  for (const field of phoneHomeResponseFields) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`phone-home response omitted ${field}`);
    }
  }
  return {
    box_id: value.box_id,
    access_token: value.access_token,
    refresh_token: value.refresh_token,
  };
}

async function pokeRegister() {
  process.stdout.write(`microvm-enroll: register start timeout_ms=${registerTimeoutMs}\n`);
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    let killGraceTimer;
    let timedOut = false;
    let timeoutKillSent = false;
    let timeoutKillError = '';
    let spawnError;
    const finish = (message, failed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      (failed ? process.stderr : process.stdout).write(`microvm-enroll: ${message}\n`);
      resolve();
    };
    let child;
    try {
      child = spawn('blitz-cred', ['register'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        uid: 1000,
        gid: 1000,
        detached: true,
        env: {
          ...process.env,
          BLITZ_STATE_DIR: stateDir,
          HOME: '/var/lib/blitz/home',
          USER: 'blitz',
        },
      });
    } catch (error) {
      finish(`register failed: ${safeError(error)}`, true);
      return;
    }
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        const killError = timeoutKillError ? ` kill_error=${timeoutKillError}` : '';
        finish(`register timeout after ${registerTimeoutMs}ms kill_sent=${timeoutKillSent}${killError}`, true);
        return;
      }
      if (spawnError) {
        finish(`register failed: ${safeError(spawnError)}`, true);
        return;
      }
      if (code === 0) {
        finish('register complete', false);
        return;
      }
      finish(`register failed: exit_code=${code === null ? 'none' : code} signal=${signal || 'none'}`, true);
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          timeoutKillSent = true;
        } catch (error) {
          timeoutKillError = safeError(error);
        }
      } else {
        timeoutKillError = 'child PID unavailable';
      }
      killGraceTimer = setTimeout(() => {
        const killError = timeoutKillError ? ` kill_error=${timeoutKillError}` : '';
        finish(`register timeout after ${registerTimeoutMs}ms kill_sent=${timeoutKillSent} close_grace_expired_after=${registerKillGraceMs}ms${killError}`, true);
      }, registerKillGraceMs);
    }, registerTimeoutMs);
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
  atomicWrite(path.join(stateDir, 'box-credential.json'), `${JSON.stringify(stored)}\n`, 0o600);
  atomicWrite(path.join(stateDir, 'origin'), `${cpOrigin}\n`, 0o644);
  await pokeRegister();
  process.stdout.write(`microvm-enroll: complete host_key_count=${hostPublicKeys.length}\n`);
}

module.exports = {
  buildPhoneHomeFailurePayload,
  buildPhoneHomePayload,
  parsePhoneHomeResponse,
};

if (require.main === module) {
  main().catch(async (error) => {
    const message = safeError(error);
    await reportFailure(message);
    process.stderr.write(`microvm-enroll: failed: ${message}\n`);
    process.exitCode = 1;
  });
}
