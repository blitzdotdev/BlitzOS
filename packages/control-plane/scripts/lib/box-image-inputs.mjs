// This list mirrors the Dockerfile's repository COPY lines, so it must move
// with them whenever the image starts or stops consuming a repository path.
export const BOX_IMAGE_INPUTS = Object.freeze([
  "packages/box",
  "packages/broker",
  "packages/schema/fixtures",
  "packages/control-plane/scripts/box-payload-key.mjs",
  "packages/control-plane/scripts/lib/box-daemon.mjs",
  "packages/control-plane/scripts/lib/box-payload-files.mjs",
  "vendor/lody/UPSTREAM.md",
  "vendor/lody/packages/shared/src/local-loro-data-plane.ts",
  "env.defaults",
]);
