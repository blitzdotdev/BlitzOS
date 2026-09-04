// This list mirrors the Dockerfile's repository COPY lines, so it must move
// with them whenever the image starts or stops consuming a repository path.
export const BOX_IMAGE_INPUTS = Object.freeze([
  "packages/box",
  "packages/broker",
  "packages/schema/fixtures",
  "env.defaults",
]);
