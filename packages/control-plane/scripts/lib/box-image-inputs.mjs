// A box-image release names the base that must be replaced as a unit. Payload
// files and the daemon are deliberately absent: an existing base boots its
// baked payload and then the updater converges it to the deployment pin. When
// one of these inputs changes, the rebuilt base bakes the payload current at
// that commit and stamps it with that payload's daemon-inclusive version.
//
// Dockerfile changes are conservatively base changes. The remaining entries
// are the base-owned rootfs files: host configuration, the payload updater,
// and the s6 service set/topology. `user/contents.d` catches additions and
// removals; the explicit type/dependency paths catch changes to existing
// services without making their payload-owned run/up scripts image inputs.
export const BOX_IMAGE_INPUTS = Object.freeze([
  "packages/box/Dockerfile",
  "packages/box/Dockerfile.dockerignore",
  "packages/box/rootfs/etc/blitz/sshd_config",
  "packages/box/rootfs/etc/gitconfig",
  "packages/box/rootfs/etc/profile.d/blitz-npm.sh",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/cgroups/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/cloudflared/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/cloudflared/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/dockerd/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/dockerd/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/dufs/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/dufs/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/enroll/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/enroll/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/gateway/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/init-state/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/init-state/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-bridge/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-bridge/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-projects/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-projects/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/machine-stats/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/machine-stats/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/payload",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/register/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/register/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/remote-control/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/remote-control/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/rules/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/rules/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/sshd/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/sshd/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/type",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/user",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/watch/dependencies.d",
  "packages/box/rootfs/etc/s6-overlay/s6-rc.d/watch/type",
  "packages/box/rootfs/etc/tmux.conf",
  "packages/box/rootfs/usr/local/libexec/blitz-payload",
  "packages/control-plane/scripts/box-payload-key.mjs",
  "packages/control-plane/scripts/lib/box-daemon.mjs",
  "packages/control-plane/scripts/lib/box-payload-files.mjs",
]);
