FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS build

WORKDIR /src
COPY packages/broker/go.mod ./
COPY packages/broker/cmd ./cmd
COPY packages/broker/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/blitz-broker ./cmd/blitz-broker

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS vendors

RUN npm install --global --omit=dev \
      @anthropic-ai/claude-code@latest \
      @openai/codex@0.147.0 \
    && npm cache clean --force

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

RUN set -eux; \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260811T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260811T000000Z|g' \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      libstdc++6=12.2.0-14+deb12u1 \
      openssh-client=1:9.2p1-2+deb12u10 \
      openssh-server=1:9.2p1-2+deb12u10 \
      passwd=1:4.13+dfsg1-1+deb12u2 \
      procps=2:4.0.2-3; \
    rm -f /etc/ssh/ssh_host_*; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY --from=vendors /usr/local/ /usr/local/
COPY --from=build /out/blitz-broker /usr/local/bin/blitz-broker
COPY env.defaults /etc/blitz/env.defaults
COPY packages/broker/sshd_config /etc/ssh/sshd_config
COPY --chmod=0755 packages/broker/entrypoint.sh /usr/local/bin/blitz-broker-entrypoint

VOLUME ["/var/lib/blitz-broker"]
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/blitz-broker-entrypoint"]
