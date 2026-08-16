import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FILES_MULTIPART_CHUNK_BYTES,
  parseAttachmentsResponse,
  parseListResponse,
  run,
} from '../rootfs/usr/local/libexec/blitz-files.mjs';

const fixturesRoot = path.resolve(
  import.meta.dirname,
  '../../schema/fixtures/files-sync',
);

async function fixture(relativePath) {
  return JSON.parse(await readFile(path.join(fixturesRoot, relativePath), 'utf8'));
}

async function stateDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blitz-files-test-'));
  const stateDir = path.join(root, 'state');
  const sharedRoot = path.join(root, 'shared');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'origin'), 'https://cp.example\n');
  await writeFile(path.join(stateDir, 'box-credential.json'), JSON.stringify({
    box_id: 'box-one',
    access_token: 'access-one',
    refresh_token: 'refresh-one',
  }));
  return { root, stateDir, sharedRoot };
}

function fakeControlPlane() {
  const remote = new Map();
  const multipart = new Map();
  const requests = [];
  let revoked = false;
  let revokeOnPart = null;
  const folder = {
    id: 'folder-one',
    name: 'Shared Notes',
    role: 'editor',
    version: 1,
    attachedAt: 1,
  };

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init.method ?? 'GET' });
    if (revoked) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/workspaces/self/folders') {
      return Response.json({ folders: [folder] });
    }
    if (url.pathname === '/folders/folder-one/objects' && (init.method ?? 'GET') === 'GET') {
      return Response.json({
        objects: [...remote.entries()].map(([key, object]) => ({
          key,
          size: object.body.byteLength,
          mtime: object.mtime,
          editedBy: 'Workspace Owner',
        })),
        cursor: null,
        truncated: false,
      });
    }
    const prefix = '/folders/folder-one/objects/';
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    const tail = url.pathname.slice(prefix.length);
    const multipartCreate = tail.match(/^(.*)\/multipart$/u);
    const multipartPart = tail.match(/^(.*)\/multipart\/upload-one\/(\d+)$/u);
    const multipartComplete = tail.match(/^(.*)\/multipart\/upload-one\/complete$/u);
    if (multipartCreate && init.method === 'POST') {
      multipart.set(decodeURIComponent(multipartCreate[1]), []);
      return Response.json({ uploadId: 'upload-one' }, { status: 201 });
    }
    if (multipartPart && init.method === 'PUT') {
      const partNumber = Number(multipartPart[2]);
      if (revokeOnPart === partNumber) return new Response('forbidden', { status: 403 });
      multipart.get(decodeURIComponent(multipartPart[1]))[partNumber - 1] = Buffer.from(init.body);
      return Response.json({ partNumber, etag: `etag-${partNumber}` });
    }
    if (multipartComplete && init.method === 'POST') {
      const key = decodeURIComponent(multipartComplete[1]);
      remote.set(key, {
        body: Buffer.concat(multipart.get(key)),
        mtime: 0,
      });
      return new Response(null, { status: 204 });
    }
    const key = decodeURIComponent(tail);
    if ((init.method ?? 'GET') === 'GET') {
      const object = remote.get(key);
      return object === undefined
        ? new Response('not found', { status: 404 })
        : new Response(object.body);
    }
    if (init.method === 'PUT') {
      remote.set(key, {
        body: Buffer.from(init.body),
        mtime: Number(new Headers(init.headers).get('x-blitz-mtime')),
      });
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    fetchImpl,
    folder,
    remote,
    requests,
    revoke() { revoked = true; },
    revokeOnPart(partNumber) { revokeOnPart = partNumber; },
  };
}

test('guest parsers conform to every shared files-sync fixture', async () => {
  const invalidAttachments = await fixture('invalid/attachments-extra-field.json');
  const invalidList = await fixture('invalid/list-missing-edited-by.json');
  assert.deepEqual(
    parseListResponse(await fixture('valid/list.json')),
    await fixture('valid/list.json'),
  );
  assert.deepEqual(
    parseAttachmentsResponse(await fixture('valid/attachments.json')),
    await fixture('valid/attachments.json'),
  );
  assert.throws(() => parseListResponse(invalidList));
  assert.throws(() => parseAttachmentsResponse(invalidAttachments));
});

test('sync pulls remote-newer, pushes local-newer, and stops at the next request after revoke', async () => {
  const directories = await stateDirectory();
  const cp = fakeControlPlane();
  cp.remote.set('notes/today.txt', {
    body: Buffer.from('remote edit'),
    mtime: 1_700_000_000_000,
  });
  try {
    await run(['sync', '--update', '--parallel', '2'], {
      stateDir: directories.stateDir,
      sharedRoot: directories.sharedRoot,
      fetchImpl: cp.fetchImpl,
    });
    const localFile = path.join(directories.sharedRoot, 'Shared Notes', 'notes', 'today.txt');
    assert.equal(await readFile(localFile, 'utf8'), 'remote edit');

    await writeFile(localFile, 'local agent edit');
    const localEdit = new Date(1_700_000_010_000);
    await utimes(localFile, localEdit, localEdit);
    await run(['sync', '--parallel', '2'], {
      stateDir: directories.stateDir,
      sharedRoot: directories.sharedRoot,
      fetchImpl: cp.fetchImpl,
    });
    assert.equal(cp.remote.get('notes/today.txt').body.toString(), 'local agent edit');
    assert.equal(cp.remote.get('notes/today.txt').mtime, 1_700_000_010_000);

    cp.revoke();
    const requestsBefore = cp.requests.length;
    await assert.rejects(run(['sync'], {
      stateDir: directories.stateDir,
      sharedRoot: directories.sharedRoot,
      fetchImpl: cp.fetchImpl,
    }), /HTTP 403/u);
    assert.equal(cp.requests.length, requestsBefore + 1);
    assert.equal(cp.requests.at(-1).path, '/workspaces/self/folders');
  } finally {
    await rm(directories.root, { recursive: true, force: true });
  }
});

test('multipart push checks the grant again for each chunk', async () => {
  const directories = await stateDirectory();
  const cp = fakeControlPlane();
  const folderRoot = path.join(directories.sharedRoot, 'Shared Notes');
  await mkdir(folderRoot, { recursive: true });
  await writeFile(
    path.join(folderRoot, 'large.bin'),
    Buffer.alloc(FILES_MULTIPART_CHUNK_BYTES + 1, 7),
  );
  cp.revokeOnPart(2);
  try {
    await assert.rejects(run(['push', '--parallel', '1'], {
      stateDir: directories.stateDir,
      sharedRoot: directories.sharedRoot,
      fetchImpl: cp.fetchImpl,
    }), /HTTP 403/u);
    assert.deepEqual(
      cp.requests.filter(({ path: requestPath }) => requestPath.includes('/multipart/upload-one/'))
        .map(({ path: requestPath }) => requestPath.split('/').at(-1)),
      ['1', '2'],
    );
  } finally {
    await rm(directories.root, { recursive: true, force: true });
  }
});
