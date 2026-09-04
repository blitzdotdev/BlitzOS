# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS cred-build

ARG TARGETARCH
WORKDIR /src/packages/broker
COPY packages/broker/go.mod ./
COPY packages/broker/cmd ./cmd
COPY packages/broker/internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/blitz-cred ./cmd/blitz-cred

FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS gateway-build

ARG TARGETARCH
WORKDIR /src/packages/box/gateway
COPY packages/box/gateway/go.mod ./
COPY packages/box/gateway/*.go ./
# The conformance tests below read the shared cross-runtime fixtures. Copy the
# whole tree: naming corpora one by one broke the image build every time a new
# contract added one, and the tree is 424 KiB.
COPY packages/schema/fixtures /src/packages/schema/fixtures
RUN go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/blitz-box-gateway .

FROM --platform=$BUILDPLATFORM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS lody-build

WORKDIR /src
RUN corepack enable
# Keep this input boundary independent of the webapp: renderer-only changes do
# not invalidate the daemon build. The lockfile governs the persistent pnpm
# store cache; the build script verifies and overlays the reviewed adapters.
COPY vendor/lody /src/vendor/lody
COPY vendor/lody-adapters /src/vendor/lody-adapters
COPY scripts/lody-build-package.mjs scripts/lody-npm-shrinkwrap.mjs scripts/lody-sync-adapters.mjs scripts/lody-package-manifest.json /src/scripts/
RUN --mount=type=cache,id=lody-pnpm-node22-pnpm10.20,target=/root/.local/share/pnpm/store/v10 \
    node /src/scripts/lody-build-package.mjs --source /src/vendor/lody --out /out

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS vendors

# Agents install into a prefix the runtime user owns, so `claude` can
# auto-update and users can `npm install -g` without root.
#
# `claude` is deliberately UNPINNED. Its version decides which models the Lody
# composer can offer (docs/LODY-MODELS.md), it updates itself on every box, and
# a build-time pin therefore only decided how stale a fresh box was on its first
# boot — it never held a version, because the first update moved it. Taking
# `@latest` at build time costs the reproducibility of this layer and buys a box
# that is current the moment it starts. `codex` stays pinned; Lody is installed
# into its independently switchable prefix in the next stage.
ENV NPM_CONFIG_PREFIX=/opt/blitz/npm
# `ws` carries no binary: it is the only dependency of
# /usr/local/libexec/blitz-lody-bridge, which reaches it through NODE_PATH.
RUN npm install --global --omit=dev \
      @anthropic-ai/claude-code@latest \
      @openai/codex@0.147.0 \
      ws@8.21.0 \
    && npm cache clean --force

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS daemon

# Lody moves independently from the member-owned agent CLI prefix. The
# publisher exports this target's baked prefix as daemon.tar.gz.
ENV NPM_CONFIG_PREFIX=/opt/blitz/lody/baked
RUN npm install --global --omit=dev lody@0.88.1 \
    && npm cache clean --force
COPY packages/box/patches/lody-local-platform.mjs /tmp/lody-local-platform.mjs
COPY packages/box/patches/lody-acp-auth-queue.mjs /tmp/lody-acp-auth-queue.mjs
COPY packages/box/patches/lody-code-collab-worktree-root.mjs /tmp/lody-code-collab-worktree-root.mjs
COPY packages/box/patches/lody-builtin-mcp-off.mjs /tmp/lody-builtin-mcp-off.mjs
COPY packages/box/patches/lody-session-sandbox.mjs /tmp/lody-session-sandbox.mjs
# Order matters only for the first: its guard is a sha256 of the bundle AS
# PUBLISHED, so nothing may rewrite the file before it runs. The others guard on
# the package version and their own anchor instead, for that reason.
RUN node /tmp/lody-local-platform.mjs /opt/blitz/lody/baked/lib/node_modules/lody/dist/index.js \
    && node /tmp/lody-acp-auth-queue.mjs /opt/blitz/lody/baked/lib/node_modules/lody/dist/index.js \
    && node /tmp/lody-code-collab-worktree-root.mjs /opt/blitz/lody/baked/lib/node_modules/lody/dist/index.js \
    && node /tmp/lody-builtin-mcp-off.mjs /opt/blitz/lody/baked/lib/node_modules/lody/dist/index.js \
    && node /tmp/lody-session-sandbox.mjs /opt/blitz/lody/baked/lib/node_modules/lody/dist/index.js \
    && rm /tmp/lody-local-platform.mjs /tmp/lody-acp-auth-queue.mjs /tmp/lody-code-collab-worktree-root.mjs /tmp/lody-builtin-mcp-off.mjs /tmp/lody-session-sandbox.mjs

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS payload-build

WORKDIR /src
COPY packages/control-plane/scripts/lib/box-payload-files.mjs /tools/box-payload-files.mjs
COPY env.defaults ./env.defaults
COPY packages/box/rootfs ./packages/box/rootfs
RUN node /tools/box-payload-files.mjs copy /src /out
COPY --from=cred-build /out/blitz-cred /out/rootfs/usr/local/bin/blitz-cred
COPY --from=gateway-build /out/blitz-box-gateway /out/rootfs/usr/local/bin/blitz-box-gateway

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS runtime-base

RUN set -eux; \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260811T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260811T000000Z|g' \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      git=1:2.39.5-0+deb12u3 \
      iproute2=6.1.0-3 \
      iptables=1.8.9-2 \
      jq=1.6-2.1+deb12u2 \
      libstdc++6=12.2.0-14+deb12u1 \
      nano=7.2-1+deb12u1 \
      openssh-client=1:9.2p1-2+deb12u10 \
      openssh-server=1:9.2p1-2+deb12u10 \
      passwd=1:4.13+dfsg1-1+deb12u2 \
      procps=2:4.0.2-3 \
      python3=3.11.2-1+b1 \
      tmux=3.3a-3 \
      vim=2:9.0.1378-2+deb12u2 \
      xz-utils=5.4.1-1+deb12u1; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/ssh/ssh_host_*; \
    groupmod --new-name blitz node; \
    usermod --login blitz --home /var/lib/blitz/home --shell /bin/bash --password '' node; \
    groupadd --system docker; \
    usermod --append --groups docker blitz

FROM runtime-base AS artifacts

ARG TARGETARCH
ADD --checksum=sha256:42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5 https://github.com/just-containers/s6-overlay/releases/download/v3.2.1.0/s6-overlay-noarch.tar.xz /tmp/s6-overlay-noarch.tar.xz
ADD --checksum=sha256:8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435 https://github.com/just-containers/s6-overlay/releases/download/v3.2.1.0/s6-overlay-x86_64.tar.xz /tmp/s6-overlay-x86_64.tar.xz
ADD --checksum=sha256:c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc https://github.com/just-containers/s6-overlay/releases/download/v3.2.1.0/s6-overlay-aarch64.tar.xz /tmp/s6-overlay-aarch64.tar.xz
ADD --checksum=sha256:8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 /tmp/ttyd-x86_64
ADD --checksum=sha256:b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.aarch64 /tmp/ttyd-aarch64
ADD --checksum=sha256:817769f726613194bcff9d0e3e481eaccc86ac11208857614f36a8c02f410977 https://github.com/sigoden/dufs/releases/download/v0.46.0/dufs-v0.46.0-x86_64-unknown-linux-musl.tar.gz /tmp/dufs-x86_64.tgz
ADD --checksum=sha256:1472123ae3aa07e49404d16b20305c2dec90c59883ebda9308717f7205e6511b https://github.com/sigoden/dufs/releases/download/v0.46.0/dufs-v0.46.0-aarch64-unknown-linux-musl.tar.gz /tmp/dufs-aarch64.tgz
ADD --checksum=sha256:9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17 https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64 /tmp/cloudflared-x86_64
ADD --checksum=sha256:65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0 https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-arm64 /tmp/cloudflared-aarch64
ADD --checksum=sha256:b0df4a43a98d7ecb708acbdb5a34a3416e13b6e39bcbbdf296f51f0f3442b29f https://download.docker.com/linux/static/stable/x86_64/docker-29.6.1.tgz /tmp/docker-x86_64.tgz
ADD --checksum=sha256:917a4bb83565bcacb38c430f08daae8b59db3256331ac23f22394f0542509881 https://download.docker.com/linux/static/stable/aarch64/docker-29.6.1.tgz /tmp/docker-aarch64.tgz
RUN set -eux; \
    mkdir -p /out/root/usr/local/bin; \
    tar -C /out/root -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
    case "$TARGETARCH" in \
      amd64) artifact_arch=x86_64 ;; \
      arm64) artifact_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    tar -C /out/root -Jxpf "/tmp/s6-overlay-$artifact_arch.tar.xz"; \
    install -m 0755 "/tmp/ttyd-$artifact_arch" /out/root/usr/local/bin/ttyd; \
    install -m 0755 "/tmp/cloudflared-$artifact_arch" /out/root/usr/local/bin/cloudflared; \
    tar -C /out/root/usr/local/bin -xzpf "/tmp/dufs-$artifact_arch.tgz" dufs; \
    tar -C /out/root/usr/local/bin --strip-components=1 -xzpf "/tmp/docker-$artifact_arch.tgz"

FROM runtime-base

COPY --from=artifacts /out/root/ /
COPY --from=vendors /opt/blitz/npm/ /opt/blitz/npm/
COPY --from=daemon /opt/blitz/lody/baked/ /opt/blitz/lody/baked/
COPY --from=payload-build /out/ /opt/blitz/payload/baked/
COPY packages/box/rootfs/ /
COPY --from=payload-build /tools/box-payload-files.mjs /tmp/box-payload-files.mjs
RUN set -eux; \
    ln -s baked /opt/blitz/payload/current; \
    ln -s baked /opt/blitz/lody/current; \
    node /tmp/box-payload-files.mjs install /; \
    rm /tmp/box-payload-files.mjs; \
    ln -s /opt/blitz/lody/current/bin/lody /usr/local/bin/lody; \
    install -d -m 0755 /workspace /var/lib/blitz /srv/blitz-files; \
    ln -s /workspace /srv/blitz-files/workspace; \
    chown -R blitz:blitz /opt/blitz/npm

# Canary ships Lody on while env.defaults keeps it off for self-hosters. This
# build argument replaces a manual sed that once let a clean rebake silently
# ship canary with Lody off.
ARG BLITZ_LODY_SESSIONS=
RUN set -eu; \
    if [ -n "$BLITZ_LODY_SESSIONS" ]; then \
      case "$BLITZ_LODY_SESSIONS" in 0|1) ;; *) echo "BLITZ_LODY_SESSIONS must be 0 or 1" >&2; exit 1 ;; esac; \
      sed -i "s/^BLITZ_LODY_SESSIONS=.*/BLITZ_LODY_SESSIONS=$BLITZ_LODY_SESSIONS/" /opt/blitz/payload/baked/rootfs/etc/blitz/env.defaults; \
      grep -qx "BLITZ_LODY_SESSIONS=$BLITZ_LODY_SESSIONS" /etc/blitz/env.defaults; \
    fi

# /usr/local/bin comes FIRST, ahead of the npm prefix, so the PATH shims at
# /usr/local/bin/claude and /usr/local/bin/codex win over the real binaries they
# exec — and so a copy a member installs into their own writable prefix cannot
# shadow them. That shadowing is the single most common way a terminal ends up
# signed out while the same box holds a valid credential.
#
# THE VENDOR CLIs UPDATE THEMSELVES, and that is the point. A new Anthropic
# model reaches the Lody composer only when the `claude` binary is new enough to
# report it in its ACP `initialize` response — every layer above is passthrough
# (docs/LODY-MODELS.md). Holding the CLI at a build-time version therefore held
# the model list at build time too, and made a box-image rebake the delivery
# mechanism for models. It no longer is: `DISABLE_AUTOUPDATER` is gone from the
# image, the shims, the profile and the broker, and codex's shim now leaves its
# startup update check on.
#
# What still protects the shims is the PATH order above, not a pin: an update
# rewrites /opt/blitz/npm in place, and /usr/local/bin sits ahead of it, so the
# updated copy is exec'd BY the shim rather than instead of it. The chown that
# hands uid 1000 write permission on the prefix is what makes the in-place
# rewrite possible, and is deliberate.
#
# LODY_PLATFORM and LODY_DATA_DIR are image-wide, not service-local, and that is
# deliberate. `lody` is on PATH, so a member can type it in a terminal. With the
# defaults it would pick the CLOUD installation profile — a second data
# directory at ~/.lody, its own host lease on 17788, its own `lody-*` socket
# basenames — see nothing of the running daemon, and offer to log in to
# lody.ai. Setting both here means every entry point, service or shell, lands on
# the one local daemon under /var/lib/blitz/lody.
#
# The path also has to stay short: `sun_path` caps a unix socket at 103 bytes
# and the daemon throws `local_ipc_socket_path_too_long` rather than falling
# back. The longest socket it opens under this root,
# /var/lib/blitz/lody/run/lody-oss-loro-data-plane.sock, is 53 bytes.
ENV HOME=/var/lib/blitz/home \
    USER=blitz \
    NPM_CONFIG_PREFIX=/opt/blitz/npm \
    LODY_PLATFORM=local \
    LODY_DATA_DIR=/var/lib/blitz/lody \
    PATH=/usr/local/bin:/opt/blitz/npm/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

VOLUME ["/var/lib/blitz"]
EXPOSE 22 7443 7444 7445
STOPSIGNAL SIGTERM
# A running container is not a reachable box. The start period covers the s6
# graph and the first tunnel connect; after that an unhealthy verdict means the
# box stopped answering while it kept running, which is exactly the state that
# used to be invisible.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD /usr/local/libexec/blitz-healthcheck
ENTRYPOINT ["/init"]
