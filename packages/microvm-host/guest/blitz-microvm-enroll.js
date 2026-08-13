#!/usr/bin/node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const stateDir = '/var/lib/blitz';
const errorPath = path.join(stateDir, 'bootstrap-error.log');

function decode(name) {
  const raw = process.env[name] || '';
  return raw ? Buffer.from(raw, 'base64url').toString('utf8') : '';
}

const phoneHomeURL = decode('BLITZ_MICROVM_PHONE_HOME_B64');
const cpOrigin = decode('BLITZ_MICROVM_CP_ORIGIN_B64');
const workspaceID = decode('BLITZ_MICROVM_WORKSPACE_B64');

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

async function reportFailure(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  atomicWrite(errorPath, line, 0o600);
  const form = new URLSearchParams({bootstrap_error: message, workspace_id: workspaceID}).toString();
  try {
    await request(phoneHomeURL, 'application/x-www-form-urlencoded', form);
  } catch (error) {
    fs.appendFileSync(errorPath, `${new Date().toISOString()} failure-report: ${safeError(error)}\n`);
  }
}

async function main() {
  if (!phoneHomeURL) throw new Error('missing phone-home URL');
  const hostPublicKeys = await waitForHostKeys();
  await waitForSSHD();
  const payload = JSON.stringify({
    workspace_id: workspaceID,
    host_public_keys: hostPublicKeys,
    ssh_host_public_keys: hostPublicKeys,
  });
  const response = await request(phoneHomeURL, 'application/json', payload);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`phone-home returned HTTP ${response.status}`);
  }
  let credential;
  try {
    credential = JSON.parse(response.body);
  } catch (_) {
    throw new Error('phone-home returned invalid JSON');
  }
  for (const field of ['box_id', 'access_token', 'refresh_token']) {
    if (!credential || typeof credential[field] !== 'string' || credential[field].length === 0) {
      throw new Error(`phone-home response omitted ${field}`);
    }
  }
  const stored = {box_id: credential.box_id, access_token: credential.access_token, refresh_token: credential.refresh_token};
  atomicWrite(path.join(stateDir, 'box-credential.json'), `${JSON.stringify(stored)}\n`, 0o600);
  atomicWrite(path.join(stateDir, 'origin'), `${cpOrigin}\n`, 0o644);
  process.stdout.write(`microvm-enroll: complete host_key_count=${hostPublicKeys.length}\n`);
}

main().catch(async (error) => {
  const message = safeError(error);
  await reportFailure(message);
  process.stderr.write(`microvm-enroll: failed: ${message}\n`);
  process.exitCode = 1;
});
