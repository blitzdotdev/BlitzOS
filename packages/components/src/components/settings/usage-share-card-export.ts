import {
  renderUsageShareCardFrame,
  resolveShareCardConfig,
  type UsageShareCardFrameInput,
} from './usage-share-card';

export type UsageShareCardVideoOptions = {
  /** Total clip length including the hold on the final frame. */
  durationMs?: number;
  fps?: number;
  /** Fraction of the clip spent animating before holding the final frame. */
  animateFraction?: number;
  bitrate?: number;
  onProgress?: (fraction: number) => void;
};

export type UsageShareCardVideo = {
  blob: Blob;
  extension: 'mp4' | 'webm';
  mimeType: string;
};

type FrameCanvas = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
};

function createFrameCanvas(input: UsageShareCardFrameInput): FrameCanvas {
  const cfg = resolveShareCardConfig(input.config);
  // Keep dimensions even so H.264 encoders accept them.
  const width = cfg.width - (cfg.width % 2);
  const height = cfg.height - (cfg.height % 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  return { canvas, context, width, height };
}

function progressAt(fraction: number, animateFraction: number): number {
  if (animateFraction <= 0) return 1;
  return Math.min(1, fraction / animateFraction);
}

/**
 * Encode the animated share card to an MP4 via WebCodecs. Resolves `null` when
 * WebCodecs or the mp4 muxer is unavailable, so callers can fall back.
 */
async function encodeWithWebCodecs(
  frame: FrameCanvas,
  input: UsageShareCardFrameInput,
  options: Required<Omit<UsageShareCardVideoOptions, 'onProgress'>>,
  onProgress?: (fraction: number) => void
): Promise<UsageShareCardVideo | null> {
  if (typeof window === 'undefined' || typeof window.VideoEncoder === 'undefined') return null;

  let muxerModule: typeof import('mp4-muxer');
  try {
    muxerModule = await import('mp4-muxer');
  } catch {
    return null;
  }
  const { Muxer, ArrayBufferTarget } = muxerModule;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: frame.width, height: frame.height },
    fastStart: 'in-memory',
  });

  const encoder = new window.VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({
    codec: 'avc1.4d0028',
    width: frame.width,
    height: frame.height,
    bitrate: options.bitrate,
    framerate: options.fps,
  });

  const totalFrames = Math.max(1, Math.round((options.durationMs / 1000) * options.fps));
  const frameDurationUs = Math.round(1_000_000 / options.fps);

  for (let index = 0; index < totalFrames; index += 1) {
    const fraction = totalFrames > 1 ? index / (totalFrames - 1) : 1;
    renderUsageShareCardFrame(
      frame.context,
      input,
      progressAt(fraction, options.animateFraction)
    );
    const videoFrame = new VideoFrame(frame.canvas, {
      timestamp: index * frameDurationUs,
      duration: frameDurationUs,
    });
    encoder.encode(videoFrame, { keyFrame: index % options.fps === 0 });
    videoFrame.close();
    onProgress?.(fraction * 0.95);
    // Yield so the encoder queue drains and the UI stays responsive.
    if (index % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  onProgress?.(1);

  const { buffer } = muxer.target as InstanceType<typeof ArrayBufferTarget>;
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    extension: 'mp4',
    mimeType: 'video/mp4',
  };
}

/** Fallback: record the animated canvas in real time via MediaRecorder. */
async function encodeWithMediaRecorder(
  frame: FrameCanvas,
  input: UsageShareCardFrameInput,
  options: Required<Omit<UsageShareCardVideoOptions, 'onProgress'>>,
  onProgress?: (fraction: number) => void
): Promise<UsageShareCardVideo> {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType =
    candidates.find(
      (candidate) =>
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)
    ) ?? 'video/webm';

  const stream = frame.canvas.captureStream(options.fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: options.bitrate });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - start;
      const fraction = Math.min(1, elapsed / options.durationMs);
      renderUsageShareCardFrame(
        frame.context,
        input,
        progressAt(fraction, options.animateFraction)
      );
      onProgress?.(fraction * 0.95);
      if (fraction >= 1) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  recorder.stop();
  await finished;
  onProgress?.(1);

  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type: mimeType }), extension, mimeType };
}

/**
 * Export the animated usage share card as a short video clip. Prefers an MP4
 * encoded with WebCodecs; falls back to MediaRecorder (mp4 or webm) when
 * WebCodecs / the mp4 muxer is unavailable.
 */
export async function exportUsageShareCardVideo(
  input: UsageShareCardFrameInput,
  options: UsageShareCardVideoOptions = {}
): Promise<UsageShareCardVideo> {
  const resolved = {
    durationMs: options.durationMs ?? 3000,
    fps: options.fps ?? 30,
    animateFraction: options.animateFraction ?? 0.82,
    bitrate: options.bitrate ?? 8_000_000,
  };
  const frame = createFrameCanvas(input);
  const viaWebCodecs = await encodeWithWebCodecs(frame, input, resolved, options.onProgress);
  if (viaWebCodecs) return viaWebCodecs;
  return await encodeWithMediaRecorder(frame, input, resolved, options.onProgress);
}
