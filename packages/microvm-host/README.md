# Blitz microVM host agent (M2)

This is a standalone, standard-library-only Go module implementing the M2
Firecracker host agent. The agent reads its runtime settings directly from the
environment; the repository-root `env.defaults` documents and supplies the
portable defaults. No scratchpad path is compiled into the package.

## Intended deployment

The primary deployment is the agent on a large public-cloud or bare-metal box,
such as AWS or Hetzner, exposed at a stable pinned HTTPS URL. Configure that URL
directly in the control plane as
`{name,url,tokenVar}`. This is the production path and requires no reporter.

Dynamic registration is only for a NAT host that cannot keep a stable
inbound URL and therefore uses a rotating Cloudflare Quick Tunnel. Quick
Tunnels are an edge-case convenience, not the production hosting model. Such a
host is configured as `{name,tokenVar,dynamic:true}`; it is unavailable until
the reporter registers a URL, and it self-heals when cloudflared emits a new
URL. This dynamic path does not participate in or override pinned-host routing.

## API

Every endpoint requires `Authorization: Bearer <token>`. The token is read once at startup from a regular mode-`0600` file and must contain at least 32 non-whitespace characters.

- `POST /v1/vms` accepts `{workspace_id,cpu,mem_mb,phone_home_url,cp_origin}` plus optional `ssh_authorized_key`, and returns HTTP 201 with `{vm_id,host_ip,ssh_port}`.
- `DELETE /v1/vms/:id` sends Firecracker `SendCtrlAltDel`, waits up to the configured timeout, then uses TERM/KILL if required. It removes the three tagged iptables rules, TAP, sparse upper disk, socket, log, and state. Missing IDs return HTTP 204.
- `GET /v1/vms` returns the persisted VM array.
- `GET /v1/capacity` returns `{total_cpu,physical_cpu,effective_cpu,total_mem_mb,used_cpu,used_mem_mb,vm_count,max_vms}`. `total_cpu` remains the allocatable ceiling used by existing clients and matches `effective_cpu`; `physical_cpu` reports the configured host CPU count.
- `GET /v1/healthz` returns `{ok,versions}` with agent, Firecracker, and kernel versions.
- `ANY /vms/:id/webapp/:port/*` streams HTTP and WebSocket traffic to the
  named guest, with `port` restricted to `7444` (ACP) or `7445` (box gateway).
  The agent bearer credential and control-plane cookie are removed before the
  request reaches the guest. Missing VMs return HTTP 404.

The first free slot determines all network resources: slot N uses TAP
`blitz-tapN`, host/guest `172.30.(20+N).1/.2/30`, and host SSH port
`BLITZ_MICROVM_SSH_PORT_BASE+N`. DNAT and both forwarding rules carry comment
`blitz-microvm:slot-N`.

The box gateway and ACP deliberately remain bound to guest loopback. During
microVM boot, `/microvm-init` enables `route_localnet` on `eth0` and installs
guest-side NAT rules that translate only traffic from the TAP gateway address,
to the guest address, on ports 7444/7445 back to `127.0.0.1`. This avoids public
host-port allocation and preserves the box image's loopback contract while
making the webApp endpoints reachable solely across each VM's host-only `/30`.

## Lifecycle and recovery

The backend preserves the proven spike mechanisms: read-only overlay lower disk on vda, a freshly formatted sparse ext4 vdb, the pinned kernel/Firecracker binary, direct Firecracker API configuration, and one isolated TAP `/30` per VM. All `ip`, `iptables`, and `sysctl` calls go through the configured append-only logged sudo wrapper.

Each VM has an atomic mode-`0600` state record under `<state_dir>/vms` and runtime artifacts under `<state_dir>/runtime/<vm_id>`. Startup reconciliation adopts a running Firecracker only when its PID identity, TAP, and all tagged rules are intact. It stops and removes incomplete records, plus untracked Firecracker processes, runtime directories, TAPs, and slot-tagged rules.

The M2 systemd unit uses `KillMode=process`, allowing a Firecracker child to survive an agent crash/restart long enough for reconciliation to adopt it. `Restart=always` keeps the API available.

## NAT Quick Tunnel setup

Use this only for the NAT case described above. First configure the
Worker and store the same token that is already in the agent's mode-`0600`
token file as a Worker secret:

```toml
MICROVM_HOSTS = '[{"name":"example-host","tokenVar":"MICROVM_LAB_TOKEN","dynamic":true}]'
```

```sh
npx wrangler secret put MICROVM_LAB_TOKEN --config packages/control-plane/wrangler.toml
```

On the host, install cloudflared and create
`/etc/systemd/system/blitz-microvm-tunnel.service` with the quick tunnel aimed
at the local agent:

```ini
[Unit]
Description=Blitz microVM Cloudflare Quick Tunnel
After=network-online.target blitz-microvm-agent.service
Wants=network-online.target

[Service]
Type=simple
User=blitz-microvm
Group=blitz-microvm
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8086
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Install the agent, reporter, units, and the repository-root defaults file.
Deployment replaces the blank host address, capacity, control-plane origin,
and registered host name in the installed copy. `TOKEN_FILE` and
`BLITZ_MICROVM_TOKEN_FILE` point at the existing protected token file; never
put the token itself in the environment file.

```sh
sudo install -d -m 0755 /usr/local/libexec /etc/blitz
sudo install -m 0755 deploy/blitz-tunnel-reporter.sh /usr/local/libexec/blitz-tunnel-reporter.sh
sudo install -m 0644 deploy/blitz-tunnel-reporter.service /etc/systemd/system/blitz-tunnel-reporter.service
sudo install -m 0644 deploy/blitz-microvm-agent.service /etc/systemd/system/blitz-microvm-agent.service
sudo install -m 0644 ../../env.defaults /etc/blitz/env.defaults
```

Set these deployment-specific entries in `/etc/blitz/env.defaults`:

```sh
CP_URL=https://control-plane.example
HOST_NAME=example-host
TOKEN_FILE=/etc/blitz/microvm-agent-token
BLITZ_MICROVM_PUBLIC_HOST_IP=203.0.113.10
BLITZ_MICROVM_TOTAL_CPU=8
BLITZ_MICROVM_TOTAL_MEM_MB=16384
```

Start all three units after the installed defaults and token file are in place:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now blitz-microvm-agent.service
sudo systemctl enable --now blitz-microvm-tunnel.service
sudo systemctl enable --now blitz-tunnel-reporter.service
journalctl -f -u blitz-tunnel-reporter.service
```

The reporter scans the tunnel unit's recent journal and follows it, extracts
each `https://*.trycloudflare.com` URL, and posts changes with exponential
backoff. It logs the URL and HTTP status only; it never logs the token.

## Guest enrollment

`guest/build-rootfs-m2.sh` copies the image supplied through
`BLITZ_BASE_SOURCE` to the versioned output path supplied through
`BLITZ_M2_BASE_OUTPUT`. It replaces only `/microvm-init` plus
`/usr/local/libexec/blitz-microvm-enroll.js` through `debugfs` and refuses to
overwrite an existing output. The recipe files default to their checked-in
locations next to the build script.

The agent passes phone-home URL, control-plane origin, and workspace ID as base64url kernel arguments. The M2 init starts a Node one-shot, then execs the image's original `/init`. The one-shot waits until the image has generated SSH host keys and sshd accepts TCP connections, POSTs JSON containing only the canonical `pub_key_ecdsa`, `pub_key_ed25519`, and `pub_key_rsa` scalar fields, and atomically writes:

- `/var/lib/blitz/box-credential.json`, mode 0600, with only `box_id`, `access_token`, and `refresh_token`.
- `/var/lib/blitz/origin`, mode 0644, containing `cp_origin`.

On failure it writes `/var/lib/blitz/bootstrap-error.log` mode 0600 and also POSTs an `application/x-www-form-urlencoded` `bootstrap_error` field to the callback.

## Build and test

```sh
go test -race ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o dist/blitz-microvm-agent-linux-amd64 ./cmd/blitz-microvm-agent
```

`integration/live-test.sh` performs the Mac-to-host health/capacity/create/enroll/SSH/webApp/delete test, verifies idempotent deletion and every resource class, then runs ten create/destroy timing cycles. It requires a temporary local mode-0600 copy of the deployed token through `BLITZ_AGENT_TOKEN_FILE`; neither the script nor agent prints token or key contents.

## M3 vendoring notes

Package files to vendor into `blitz-core`:

- `allocator.go`, `config.go`, `http.go`, `linux_backend.go`, `manager.go`, `state_store.go`, `types.go`
- `cmd/blitz-microvm-agent/main.go` if the standalone daemon entry point is retained
- `guest/microvm-init`, `guest/blitz-microvm-enroll.js`, and `guest/build-rootfs-m2.sh` for the versioned guest image recipe
- `deploy/blitz-microvm-agent.service` and the optional NAT-host-only
  `deploy/blitz-tunnel-reporter.*` files as the live-host deployment reference

Config knobs are the API bind/public address, token/state paths, pinned
binary/kernel/rootfs paths and version labels, guest DNS resolvers, sudo
wrapper, network prefix/octet/slot range, SSH port base, sparse upper size,
total CPU/RAM, CPU overcommit ratio, maximum VM count, and graceful shutdown
timeout. `BLITZ_MICROVM_CPU_OVERCOMMIT` is a floating-point multiplier, and
fractional effective capacity is rounded down to a whole vCPU. The complete
contract and portable defaults live in the repository-root `env.defaults`;
the service reads the installed copy from `/etc/blitz/env.defaults`.
