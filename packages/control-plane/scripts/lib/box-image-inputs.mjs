// A box-image release names the base that must be replaced as a unit. Payload
// files and the daemon are deliberately absent: an existing base boots its
// baked payload and then the updater converges it to the deployment pin. When
// one of these inputs changes, the rebuilt base bakes the payload current at
// that commit and stamps it with that payload's daemon-inclusive version.
//
// Dockerfile changes are conservatively base changes. The remaining entries
// are the base-owned rootfs files: the payload updater. The complete s6
// service tree and ordinary box configuration belong to the payload.
export const BOX_IMAGE_INPUTS = Object.freeze([
  "packages/broker/cmd/blitz-cred",
  "packages/broker/go.mod",
  "packages/broker/internal",
  "packages/box/Dockerfile",
  "packages/box/Dockerfile.dockerignore",
  "packages/box/rootfs/usr/local/libexec/blitz-payload",
  "packages/control-plane/scripts/box-payload-key.mjs",
  "packages/control-plane/scripts/lib/box-daemon.mjs",
  "packages/control-plane/scripts/lib/box-payload-files.mjs",
]);

// Build-context sources the Dockerfile ALSO copies that are not base inputs.
// They reach a running box through the payload channel: the gateway sources
// become the payload's `blitz-box-gateway` binary, and the Lody tree, its
// reviewed adapter snapshots and the shared build scripts become
// `daemon.tar.gz`. The payload version hashes those built artifacts, so a
// change here publishes a payload and reuses the base image.
// `test/box-image-key.test.mjs` proves every Dockerfile COPY source is a base
// input, one of these, or a payload-owned rootfs file (`box-payload-files.mjs`).
export const BOX_PAYLOAD_SOURCE_INPUTS = Object.freeze([
  "packages/box/gateway",
  "packages/schema/fixtures",
  "scripts/lody-build-package.mjs",
  "scripts/lody-npm-shrinkwrap.mjs",
  "scripts/lody-package-manifest.json",
  "scripts/lody-sync-adapters.mjs",
  "vendor/lody",
  "vendor/lody-adapters",
]);
