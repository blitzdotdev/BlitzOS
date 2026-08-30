import { IncrementalSha256 } from '@lody/shared';

type HashRequest = {
  readonly file: File;
  readonly chunkSizeBytes: number;
};

type HashResponse =
  | { readonly type: 'progress'; readonly loadedBytes: number; readonly totalBytes: number }
  | { readonly type: 'complete'; readonly sha256: string }
  | { readonly type: 'error'; readonly message: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage: (message: HashResponse) => void;
};

worker.onmessage = (event) => {
  void hashFile(event.data);
};

async function hashFile(request: HashRequest): Promise<void> {
  const { file, chunkSizeBytes } = request;
  const hasher = new IncrementalSha256();
  try {
    for (let offset = 0; offset < file.size; offset += chunkSizeBytes) {
      const end = Math.min(offset + chunkSizeBytes, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer();
      hasher.update(new Uint8Array(buffer));
      worker.postMessage({ type: 'progress', loadedBytes: end, totalBytes: file.size });
    }
    worker.postMessage({ type: 'complete', sha256: hasher.digestHex() });
  } catch (error) {
    worker.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
