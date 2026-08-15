# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS cred-build

ARG TARGETARCH
WORKDIR /src/packages/broker
COPY packages/broker/go.mod ./
COPY packages/broker/cmd ./cmd
COPY packages/broker/internal ./internal
RUN CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -ldflags="-s -w" -o /out/blitz-cred ./cmd/blitz-cred

FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS gateway-build

ARG TARGETARCH
WORKDIR /src/packages/box/gateway
COPY packages/box/gateway/go.mod ./
COPY packages/box/gateway/*.go ./
RUN go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -ldflags="-s -w" -o /out/blitz-box-gateway .

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS actor-build

RUN set -eux; \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260811T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260811T000000Z|g' \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      g++=4:12.2.0-3 \
      make=4.3-4.1 \
      python3=3.11.2-1+b1; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY tsconfig.base.json /src/tsconfig.base.json
WORKDIR /src/packages/box/actor
COPY packages/box/actor/package.json packages/box/actor/package-lock.json ./
RUN npm ci
COPY packages/box/actor/tsconfig.json ./
COPY packages/box/actor/src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS vendors

RUN npm install --global --omit=dev \
      @anthropic-ai/claude-code@2.1.228 \
      @openai/codex@0.147.0 \
    && npm cache clean --force

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
      git=1:2.39.5-0+deb12u3 \
      iproute2=6.1.0-3 \
      iptables=1.8.9-2 \
      libstdc++6=12.2.0-14+deb12u1 \
      openssh-client=1:9.2p1-2+deb12u10 \
      openssh-server=1:9.2p1-2+deb12u10 \
      passwd=1:4.13+dfsg1-1+deb12u2 \
      procps=2:4.0.2-3 \
      tmux=3.3a-3 \
      xz-utils=5.4.1-1+deb12u1; \
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
    tar -C /out/root/usr/local/bin -xzpf "/tmp/dufs-$artifact_arch.tgz" dufs; \
    tar -C /out/root/usr/local/bin --strip-components=1 -xzpf "/tmp/docker-$artifact_arch.tgz"

FROM runtime-base

COPY --from=artifacts /out/root/ /
COPY --from=vendors /usr/local/ /usr/local/
COPY --from=cred-build /out/blitz-cred /usr/local/bin/blitz-cred
COPY --from=gateway-build /out/blitz-box-gateway /usr/local/bin/blitz-box-gateway
COPY --from=actor-build /src/packages/box/actor/package.json /opt/blitz/actor/package.json
COPY --from=actor-build /src/packages/box/actor/package-lock.json /opt/blitz/actor/package-lock.json
COPY --from=actor-build /src/packages/box/actor/dist /opt/blitz/actor/dist
COPY --from=actor-build /src/packages/box/actor/node_modules /opt/blitz/actor/node_modules
COPY packages/box/rootfs/ /
RUN set -eux; \
    chmod 0755 /usr/local/libexec/blitz-* /etc/s6-overlay/s6-rc.d/*/run; \
    install -d -m 0755 /workspace /var/lib/blitz /srv/blitz-files; \
    ln -s /workspace /srv/blitz-files/workspace; \
    ln -s /var/lib/blitz/home /srv/blitz-files/home

ENV BLITZ_STATE_DIR=/var/lib/blitz \
    HOME=/var/lib/blitz/home \
    USER=blitz

VOLUME ["/var/lib/blitz"]
EXPOSE 22 7443 7444 7445
STOPSIGNAL SIGTERM
ENTRYPOINT ["/init"]
