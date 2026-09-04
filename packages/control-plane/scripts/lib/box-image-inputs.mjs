// This list mirrors the Dockerfile's repository COPY lines, so it must move
// with them whenever the image starts or stops consuming a repository path.
export const BOX_IMAGE_INPUTS = Object.freeze([
  "packages/box",
  "packages/broker",
  "packages/schema/fixtures",
  "vendor/lody",
  "vendor/lody-adapters",
  "scripts/lody-build-package.mjs",
  "scripts/lody-npm-shrinkwrap.mjs",
  "scripts/lody-sync-adapters.mjs",
  "scripts/lody-package-manifest.json",
  "env.defaults",
]);
