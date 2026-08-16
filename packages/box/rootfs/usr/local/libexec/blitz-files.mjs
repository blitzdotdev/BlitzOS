#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const FILES_MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_PARALLEL = 4;
const DEFAULT_SHARED_ROOT = '/workspace/shared';
const HELP = `Usage: blitz-files pull|push|sync|attach-list [--update] [--parallel N]

Attached folders materialize below /workspace/shared/<name>.
Transfers compare mtime and size with --update semantics: a newer destination
is never overwritten. sync pulls remote-newer files, then pushes local-newer
files. Transfers are stateless and never propagate deletes; deleting the
containing folder in the webapp is the only v1 removal path. Every list, file,
and multipart chunk request is checked
by the control plane, so revocation stops the next request.
`;

function isRecord(value) {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function isString(value) {
  return Object.prototype.toString.call(value) === '[object String]';
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function validRole(value) {
  return value === 'owner' || value === 'admin' || value === 'editor' || value === 'viewer';
}

function parseObject(value) {
  if (
    !isRecord(value)
    || !exactKeys(value, ['key', 'size', 'mtime', 'editedBy'])
    || !isString(value.key)
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || !Number.isSafeInteger(value.mtime)
    || value.mtime < 0
    || !isString(value.editedBy)
  ) throw new Error('invalid files list object');
  validateRelativeKey(value.key);
  return {
    key: value.key,
    size: value.size,
    mtime: value.mtime,
    editedBy: value.editedBy,
  };
}

export function parseListResponse(value) {
  if (
    !isRecord(value)
    || !exactKeys(value, ['objects', 'cursor', 'truncated'])
    || !Array.isArray(value.objects)
    || !(value.cursor === null || isString(value.cursor))
    || !(value.truncated === true || value.truncated === false)
    || (value.truncated && value.cursor === null)
  ) throw new Error('invalid files list response');
  return {
    objects: value.objects.map(parseObject),
    cursor: value.cursor,
    truncated: value.truncated,
  };
}

function parseAttachment(value) {
  if (
    !isRecord(value)
    || !exactKeys(value, ['id', 'name', 'role', 'version', 'attachedAt'])
    || !isString(value.id)
    || value.id.length === 0
    || !isString(value.name)
    || !validRole(value.role)
    || !Number.isSafeInteger(value.version)
    || value.version < 1
    || !Number.isSafeInteger(value.attachedAt)
    || value.attachedAt < 0
  ) throw new Error('invalid folder attachment');
  safeFolderName(value.name);
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    version: value.version,
    attachedAt: value.attachedAt,
  };
}

export function parseAttachmentsResponse(value) {
  if (!isRecord(value) || !exactKeys(value, ['folders']) || !Array.isArray(value.folders)) {
    throw new Error('invalid folder attachments response');
  }
  return { folders: value.folders.map(parseAttachment) };
}

function safeFolderName(value) {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\u0000')
  ) throw new Error('attached folder has an unsafe name');
  return value;
}

function validateRelativeKey(value) {
  if (!isString(value) || value.length === 0 || value.startsWith('/') || value.includes('\\')) {
    throw new Error('invalid relative object key');
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('invalid relative object key');
  }
  return value;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function validateOrigin(raw) {
  const origin = new URL(raw);
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '::1';
  if (
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))
    || origin.username !== ''
    || origin.password !== ''
    || (origin.pathname !== '/' && origin.pathname !== '')
    || origin.search !== ''
    || origin.hash !== ''
  ) throw new Error('stored control-plane origin is invalid');
  return origin.origin;
}

function parseCredential(value) {
  if (
    !isRecord(value)
    || !exactKeys(value, ['box_id', 'access_token', 'refresh_token'])
    || !isString(value.box_id)
    || !isString(value.access_token)
    || !isString(value.refresh_token)
    || value.box_id.length === 0
    || value.access_token.length === 0
    || value.refresh_token.length === 0
  ) throw new Error('invalid box credential');
  return value;
}

async function configuration(options) {
  const stateDir = options.stateDir ?? process.env.BLITZ_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('BLITZ_STATE_DIR is required');
  const [originText, credentialText] = await Promise.all([
    readFile(path.join(stateDir, 'origin'), 'utf8'),
    readFile(path.join(stateDir, 'box-credential.json'), 'utf8'),
  ]);
  return {
    stateDir,
    origin: validateOrigin(originText.trim()),
    credential: parseCredential(parseJson(credentialText, 'box credential')),
  };
}

async function saveCredential(stateDir, credential) {
  const destination = path.join(stateDir, 'box-credential.json');
  const temporary = `${destination}.blitz-files-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function responseError(response, label) {
  const body = (await response.text()).slice(0, 512).trim();
  return new Error(`${label} failed (HTTP ${response.status})${body ? `: ${body}` : ''}`);
}

async function responseJson(response, label) {
  return parseJson(await response.text(), label);
}

async function createControlPlaneClient(options) {
  const config = await configuration(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let credential = config.credential;
  let refreshPromise = null;

  const refresh = async (staleAccess) => {
    if (credential.access_token !== staleAccess) return;
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      const response = await fetchImpl(`${config.origin}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refresh_token,
        }),
      });
      if (!response.ok) throw await responseError(response, 'token refresh');
      const value = await responseJson(response, 'token refresh');
      if (
        !isRecord(value)
        || value.box_id !== credential.box_id
        || !isString(value.access_token)
        || !isString(value.refresh_token)
        || value.access_token.length === 0
        || value.refresh_token.length === 0
      ) throw new Error('token refresh returned invalid credentials');
      credential = {
        box_id: value.box_id,
        access_token: value.access_token,
        refresh_token: value.refresh_token,
      };
      await saveCredential(config.stateDir, credential);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  return {
    async request(relativePath, init = {}) {
      const issue = () => fetchImpl(`${config.origin}${relativePath}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${credential.access_token}`,
        },
      });
      const staleAccess = credential.access_token;
      let response = await issue();
      if (response.status === 401) {
        await refresh(staleAccess);
        response = await issue();
      }
      if (!response.ok) throw await responseError(response, relativePath);
      return response;
    },
  };
}

function objectPath(folderId, key) {
  return `/folders/${encodeURIComponent(folderId)}/objects/${encodeURIComponent(key)}`;
}

async function attachments(client) {
  return parseAttachmentsResponse(await responseJson(
    await client.request('/workspaces/self/folders'),
    'folder attachments',
  )).folders;
}

async function remoteObjects(client, folderId) {
  const objects = [];
  let cursor = null;
  do {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const page = parseListResponse(await responseJson(
      await client.request(`/folders/${encodeURIComponent(folderId)}/objects${query}`),
      'folder objects',
    ));
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor !== null);
  return objects;
}

async function mapParallel(values, limit, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index], index);
    }
  });
  await Promise.all(workers);
}

async function walkLocal(root) {
  const result = new Map();
  const visit = async (directory, prefix) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.blitz-files-tmp-') || entry.isSymbolicLink()) continue;
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, key);
      else if (entry.isFile()) {
        const details = await stat(absolute);
        result.set(validateRelativeKey(key), {
          path: absolute,
          size: details.size,
          mtime: Math.trunc(details.mtimeMs),
        });
      }
    }
  };
  await visit(root, '');
  return result;
}

function localPath(folderRoot, key) {
  validateRelativeKey(key);
  return path.join(folderRoot, ...key.split('/'));
}

async function downloadOne(client, folder, folderRoot, object) {
  const response = await client.request(objectPath(folder.id, object.key));
  if (response.body === null) throw new Error(`download ${object.key} returned no body`);
  const destination = localPath(folderRoot, object.key);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.blitz-files-tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await rename(temporary, destination);
  const edited = new Date(object.mtime);
  await utimes(destination, edited, edited);
}

async function readChunk(filename, offset, length) {
  const handle = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function uploadOne(client, folder, key, local, parallel) {
  const target = objectPath(folder.id, key);
  if (local.size <= FILES_MULTIPART_CHUNK_BYTES) {
    await client.request(target, {
      method: 'PUT',
      headers: { 'x-blitz-mtime': String(local.mtime) },
      body: await readFile(local.path),
    });
    return;
  }
  const created = await responseJson(await client.request(`${target}/multipart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mtime: local.mtime }),
  }), 'multipart create');
  if (!isRecord(created) || !exactKeys(created, ['uploadId']) || !isString(created.uploadId)) {
    throw new Error('multipart create returned invalid data');
  }
  const partCount = Math.ceil(local.size / FILES_MULTIPART_CHUNK_BYTES);
  const parts = new Array(partCount);
  await mapParallel(Array.from({ length: partCount }, (_, index) => index), parallel, async (index) => {
    const offset = index * FILES_MULTIPART_CHUNK_BYTES;
    const body = await readChunk(
      local.path,
      offset,
      Math.min(FILES_MULTIPART_CHUNK_BYTES, local.size - offset),
    );
    const value = await responseJson(await client.request(
      `${target}/multipart/${encodeURIComponent(created.uploadId)}/${index + 1}`,
      { method: 'PUT', body },
    ), 'multipart part');
    if (
      !isRecord(value)
      || !exactKeys(value, ['partNumber', 'etag'])
      || value.partNumber !== index + 1
      || !isString(value.etag)
    ) throw new Error('multipart part returned invalid data');
    parts[index] = { partNumber: value.partNumber, etag: value.etag };
  });
  await client.request(`${target}/multipart/${encodeURIComponent(created.uploadId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
  });
}

async function pullFolder(client, folder, sharedRoot, parallel) {
  const folderRoot = path.join(sharedRoot, safeFolderName(folder.name));
  await mkdir(folderRoot, { recursive: true });
  const [remote, local] = await Promise.all([
    remoteObjects(client, folder.id),
    walkLocal(folderRoot),
  ]);
  const downloads = remote.filter((object) => {
    const destination = local.get(object.key);
    return destination === undefined
      || object.mtime > destination.mtime
      || (object.mtime === destination.mtime && object.size !== destination.size);
  });
  await mapParallel(downloads, parallel, (object) => (
    downloadOne(client, folder, folderRoot, object)
  ));
}

async function pushFolder(client, folder, sharedRoot, parallel) {
  if (folder.role === 'viewer') return;
  const folderRoot = path.join(sharedRoot, safeFolderName(folder.name));
  await mkdir(folderRoot, { recursive: true });
  const [remoteList, local] = await Promise.all([
    remoteObjects(client, folder.id),
    walkLocal(folderRoot),
  ]);
  const remote = new Map(remoteList.map((object) => [object.key, object]));
  const uploads = [...local.entries()].filter(([key, source]) => {
    const destination = remote.get(key);
    return destination === undefined
      || source.mtime > destination.mtime
      || (source.mtime === destination.mtime && source.size !== destination.size);
  });
  await mapParallel(uploads, parallel, ([key, source]) => (
    uploadOne(client, folder, key, source, 1)
  ));
}

function parseArguments(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { command: 'help', parallel: DEFAULT_PARALLEL };
  if (!['pull', 'push', 'sync', 'attach-list'].includes(command)) {
    throw new Error(HELP.trimEnd());
  }
  let parallel = DEFAULT_PARALLEL;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update') continue;
    if (argument === '--parallel') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
        throw new Error('--parallel must be an integer from 1 through 32');
      }
      parallel = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { command, parallel };
}

export async function run(argv, options = {}) {
  const parsed = parseArguments(argv);
  const output = options.stdout ?? process.stdout;
  if (parsed.command === 'help') {
    output.write(HELP);
    return;
  }
  const client = await createControlPlaneClient(options);
  const attached = await attachments(client);
  if (parsed.command === 'attach-list') {
    output.write(`${JSON.stringify({ folders: attached }, null, 2)}\n`);
    return;
  }
  const sharedRoot = options.sharedRoot ?? DEFAULT_SHARED_ROOT;
  if (parsed.command === 'pull' || parsed.command === 'sync') {
    for (const folder of attached) await pullFolder(client, folder, sharedRoot, parsed.parallel);
  }
  if (parsed.command === 'push' || parsed.command === 'sync') {
    for (const folder of attached) await pushFolder(client, folder, sharedRoot, parsed.parallel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'blitz-files failed'}\n`);
    process.exitCode = 1;
  });
}
