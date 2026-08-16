import {
  FILES_MULTIPART_CHUNK_BYTES,
  type FolderObjectView,
  type ListFolderObjectsResponse,
} from "../wire.js";
import { rows } from "../db.js";
import {
  HttpError,
  isNumber,
  isRecord,
  isString,
  readJson,
  type JsonValue,
} from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { filesActorForRequest, requireFolderAccess } from "./access.js";
import { folderObjectKey, folderObjectPrefix, relativeObjectKey } from "./keys.js";
import { scheduleFolderSync } from "./sync.js";

const MTIME_METADATA = "mtime";
const EDITED_BY_METADATA = "edited-by";

interface MultipartCreateInput { mtime: number }
interface UploadedPartInput { partNumber: number; etag: string }
interface MultipartCompleteInput { parts: UploadedPartInput[] }

function validMtime(value: JsonValue | undefined, field = "mtime"): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, `${field} must be a non-negative integer`);
  }
  return value;
}

function mtimeHeader(request: Request): number {
  const value = request.headers.get("x-blitz-mtime");
  if (value === null || !/^\d+$/u.test(value)) {
    throw new HttpError(400, "x-blitz-mtime must be a non-negative integer");
  }
  return validMtime(Number(value), "x-blitz-mtime");
}

function parseMultipartCreate(value: JsonValue): MultipartCreateInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  return { mtime: validMtime(value.mtime) };
}

function parseMultipartComplete(value: JsonValue): MultipartCompleteInput {
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw new HttpError(400, "parts must be a non-empty array");
  }
  const parts = value.parts.map((candidate, index) => {
    if (!isRecord(candidate)) throw new HttpError(400, `parts[${index}] must be an object`);
    const partNumber = candidate.partNumber;
    if (!isNumber(partNumber) || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new HttpError(400, `parts[${index}].partNumber is invalid`);
    }
    if (!isString(candidate.etag) || candidate.etag.length === 0 || candidate.etag.length > 256) {
      throw new HttpError(400, `parts[${index}].etag is invalid`);
    }
    return { partNumber, etag: candidate.etag };
  });
  const numbers = new Set(parts.map(({ partNumber }) => partNumber));
  if (numbers.size !== parts.length) throw new HttpError(400, "part numbers must be unique");
  parts.sort((left, right) => left.partNumber - right.partNumber);
  return { parts };
}

function requestBody(request: Request): ReadableStream<Uint8Array> {
  if (request.body === null) throw new HttpError(400, "request body is required");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > FILES_MULTIPART_CHUNK_BYTES) {
      throw new HttpError(413, `file chunk exceeds ${FILES_MULTIPART_CHUNK_BYTES} bytes`);
    }
  }
  return request.body;
}

function objectView(object: R2Object, prefix: string): FolderObjectView {
  const mtimeValue = object.customMetadata?.[MTIME_METADATA];
  const editedBy = object.customMetadata?.[EDITED_BY_METADATA];
  if (mtimeValue === undefined || !/^\d+$/u.test(mtimeValue) || editedBy === undefined) {
    throw new Error(`folder object ${object.key} has invalid metadata`);
  }
  const mtime = Number(mtimeValue);
  if (!Number.isSafeInteger(mtime)) {
    throw new Error(`folder object ${object.key} has invalid mtime metadata`);
  }
  return { key: object.key.slice(prefix.length), size: object.size, mtime, editedBy };
}

function routeKey(context: CoreContext): string {
  return relativeObjectKey(context.req.param("key"));
}

async function touchFolder(runtime: ReturnType<RuntimeFactory>, folderId: string): Promise<void> {
  await rows(runtime.db, {
    q: "UPDATE folders SET updated_at = ?1 WHERE id = ?2",
    v: [Date.now(), folderId],
  });
}

export function addFolderObjectRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/folders/:id/objects", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "read");
    const requestUrl = new URL(context.req.url);
    const cursor = requestUrl.searchParams.get("cursor") ?? undefined;
    const page = await runtime.fileObjects.list({
      prefix: folderObjectPrefix(folder.org_id, folder.id),
      cursor,
      limit: 1_000,
      include: ["customMetadata"],
    });
    const prefix = folderObjectPrefix(folder.org_id, folder.id);
    const response: ListFolderObjectsResponse = {
      objects: page.objects.map((object) => objectView(object, prefix)),
      cursor: page.truncated ? page.cursor : null,
      truncated: page.truncated,
    };
    return context.json(response);
  });

  router.post("/folders/:id/objects/:key/multipart", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "write");
    const input = parseMultipartCreate(await readJson(context.req.raw));
    const key = folderObjectKey(folder.org_id, folder.id, routeKey(context));
    const upload = await runtime.fileObjects.createMultipartUpload(key, {
      customMetadata: {
        [MTIME_METADATA]: String(input.mtime),
        [EDITED_BY_METADATA]: actor.editedBy,
      },
    });
    return context.json({ uploadId: upload.uploadId }, 201);
  });

  router.put(
    "/folders/:id/objects/:key/multipart/:uploadId/:part",
    async (context) => {
      const runtime = runtimeFactory(context);
      const actor = await filesActorForRequest(runtime, context, requirePrincipal);
      const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "write");
      const partNumber = Number(context.req.param("part"));
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new HttpError(400, "part must be an integer from 1 through 10000");
      }
      const key = folderObjectKey(folder.org_id, folder.id, routeKey(context));
      const upload = runtime.fileObjects.resumeMultipartUpload(
        key,
        context.req.param("uploadId"),
      );
      const uploaded = await upload.uploadPart(partNumber, requestBody(context.req.raw));
      return context.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    },
  );

  router.post(
    "/folders/:id/objects/:key/multipart/:uploadId/complete",
    async (context) => {
      const runtime = runtimeFactory(context);
      const actor = await filesActorForRequest(runtime, context, requirePrincipal);
      const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "write");
      const input = parseMultipartComplete(await readJson(context.req.raw));
      const key = folderObjectKey(folder.org_id, folder.id, routeKey(context));
      const upload = runtime.fileObjects.resumeMultipartUpload(
        key,
        context.req.param("uploadId"),
      );
      await upload.complete(input.parts);
      await touchFolder(runtime, folder.id);
      scheduleFolderSync(runtime, folder.id);
      return context.body(null, 204);
    },
  );

  router.get("/folders/:id/objects/:key", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "read");
    const key = folderObjectKey(folder.org_id, folder.id, routeKey(context));
    const object = await runtime.fileObjects.get(key);
    if (object === null) throw new HttpError(404, "object not found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-length", String(object.size));
    headers.set("etag", object.httpEtag);
    const mtimeValue = object.customMetadata?.[MTIME_METADATA];
    const editedBy = object.customMetadata?.[EDITED_BY_METADATA];
    if (mtimeValue !== undefined) headers.set("x-blitz-mtime", mtimeValue);
    if (editedBy !== undefined) headers.set("x-blitz-edited-by", editedBy);
    return new Response(object.body, { headers });
  });

  router.put("/folders/:id/objects/:key", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(runtime.db, context.req.param("id"), actor, "write");
    const key = folderObjectKey(folder.org_id, folder.id, routeKey(context));
    await runtime.fileObjects.put(key, requestBody(context.req.raw), {
      httpMetadata: context.req.raw.headers,
      customMetadata: {
        [MTIME_METADATA]: String(mtimeHeader(context.req.raw)),
        [EDITED_BY_METADATA]: actor.editedBy,
      },
    });
    await touchFolder(runtime, folder.id);
    scheduleFolderSync(runtime, folder.id);
    return context.body(null, 204);
  });
}
