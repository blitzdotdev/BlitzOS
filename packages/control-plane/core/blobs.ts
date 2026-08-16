export interface BlobObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

export interface BlobStore {
  get(logicalKey: string): Promise<BlobObject | null>;
}

export interface LogicalBlobLookup {
  get(kind: "box-image" | "webApp", logicalPath: string): Promise<BlobObject | null>;
}

export const NullBlobStore: BlobStore = {
  async get(): Promise<null> {
    return null;
  },
};

interface ByteRange {
  start: number;
  end: number;
}

function rangeFromHeader(value: string | null, size: number): ByteRange | null | false {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return false;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return false;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function rangedBody(
  body: ReadableStream<Uint8Array>,
  range: ByteRange,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let remaining = range.end - range.start + 1;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const chunkStart = offset;
        const chunkEnd = offset + chunk.byteLength;
        offset = chunkEnd;
        if (remaining === 0 || chunkEnd <= range.start) return;
        const from = Math.max(0, range.start - chunkStart);
        const length = Math.min(chunk.byteLength - from, remaining);
        if (length > 0) {
          controller.enqueue(chunk.subarray(from, from + length));
          remaining -= length;
        }
      },
    }),
  );
}

export function blobResponse(object: BlobObject, request?: Request): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);

  const ifNoneMatch = request?.headers.get("if-none-match");
  if (ifNoneMatch === "*" || ifNoneMatch?.split(",").some((tag) => tag.trim() === object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  const ifMatch = request?.headers.get("if-match");
  if (
    ifMatch !== null &&
    ifMatch !== undefined &&
    ifMatch !== "*" &&
    !ifMatch.split(",").some((tag) => tag.trim() === object.httpEtag)
  ) {
    return new Response(null, { status: 412, headers });
  }

  const ifRange = request?.headers.get("if-range");
  const range = rangeFromHeader(
    ifRange !== null && ifRange !== undefined && ifRange !== object.httpEtag
      ? null
      : (request?.headers.get("range") ?? null),
    object.size,
  );
  if (range === false) {
    headers.set("content-range", `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range !== null) {
    const length = range.end - range.start + 1;
    headers.set("content-length", String(length));
    headers.set("content-range", `bytes ${range.start}-${range.end}/${object.size}`);
    return new Response(rangedBody(object.body, range), { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

export async function streamBlob(
  store: BlobStore,
  logicalKey: string,
  request?: Request,
): Promise<Response | null> {
  const object = await store.get(logicalKey);
  return object === null ? null : blobResponse(object, request);
}
