import { CORE_MANIFEST, TEXT_ASSETS, createUploadSet } from "../scripts/build-blitzdev.mjs";

// Shared Target B (blitz.dev managed) upload-set builder. The emitter reads
// core/ and the box-image skeleton from disk; a Worker-pool test has no disk,
// so the same bytes arrive through Vite's ?raw glob and go through the exact
// same createUploadSet the build script calls.

const rawCore = import.meta.glob<string>(["../core/**/*.ts", "../core/**/*.js"], {
  eager: true,
  import: "default",
  query: "?raw",
});

const rawTextAssets = import.meta.glob<string>("../../box/rootfs/opt/blitz/skel/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
});

export function coreSources(): Map<string, string> {
  return new Map(CORE_MANIFEST.map((uploadPath) => {
    const source = rawCore[`../${uploadPath}`];
    if (source === undefined) throw new Error(`missing test source ${uploadPath}`);
    return [uploadPath, source];
  }));
}

export function textAssets(): Map<string, string> {
  return new Map(TEXT_ASSETS.map((asset) => {
    const source = rawTextAssets[`../${asset.sourcePath}`];
    if (source === undefined) throw new Error(`missing test text asset ${asset.sourcePath}`);
    return [asset.uploadPath, source];
  }));
}

export function managedUploadSet(): ReturnType<typeof createUploadSet> {
  return createUploadSet(coreSources(), textAssets());
}
