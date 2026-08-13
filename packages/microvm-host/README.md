# Blitz microVM host agent (M2)

This is a standalone, standard-library-only Go module implementing the M2 Firecracker host agent. Runtime paths come exclusively from JSON config; no scratchpad path is compiled into the package.

## API

Every endpoint requires `Authorization: Bearer <token>`. The token is read once at startup from a regular mode-`0600` file and must contain at least 32 non-whitespace characters.

- `POST /v1/vms` accepts `{workspace_id,cpu,mem_mb,ssh_authorized_key,phone_home_url,cp_origin}` and returns HTTP 201 with `{vm_id,host_ip,ssh_port}`.
- `DELETE /v1/vms/:id` sends Firecracker `SendCtrlAltDel`, waits up to the configured timeout, then uses TERM/KILL if required. It removes the three tagged iptables rules, TAP, sparse upper disk, socket, log, and state. Missing IDs return HTTP 204.
- `GET /v1/vms` returns the persisted VM array.
- `GET /v1/capacity` returns `{total_cpu,physical_cpu,effective_cpu,total_mem_mb,used_cpu,used_mem_mb,vm_count,max_vms}`. `total_cpu` remains the allocatable ceiling used by existing clients and matches `effective_cpu`; `physical_cpu` reports the configured host CPU count.
- `GET /v1/healthz` returns `{ok,versions}` with agent, Firecracker, and kernel versions.

The first free slot determines all network resources: slot N uses TAP `blitz-tapN`, host/guest `172.30.(20+N).1/.2/30`, and host SSH port `22000+N`. DNAT and both forwarding rules carry comment `blitz-microvm:slot-N`.

## Lifecycle and recovery

The backend preserves the proven spike mechanisms: read-only overlay lower disk on vda, a freshly formatted sparse ext4 vdb, the pinned kernel/Firecracker binary, direct Firecracker API configuration, and one isolated TAP `/30` per VM. All `ip`, `iptables`, and `sysctl` calls go through `sudo_wrapper`, which is the lab's append-only logged sudo wrapper.

Each VM has an atomic mode-`0600` state record under `<state_dir>/vms` and runtime artifacts under `<state_dir>/runtime/<vm_id>`. Startup reconciliation adopts a running Firecracker only when its PID identity, TAP, and all tagged rules are intact. It stops and removes incomplete records, plus untracked Firecracker processes, runtime directories, TAPs, and slot-tagged rules.

The M2 systemd unit uses `KillMode=process`, allowing a Firecracker child to survive an agent crash/restart long enough for reconciliation to adopt it. `Restart=always` keeps the API available.

## Guest enrollment

`guest/build-rootfs-m2.sh` copies the spike base to the versioned `blitz-box-base-m2-v3.ext4` and replaces only `/microvm-init` plus `/usr/local/libexec/blitz-microvm-enroll.js` through `debugfs`; it refuses to overwrite an existing version. The spike's `blitz-box-base.ext4` remains unchanged. The host also retains the preflight `m2-v1` image, superseded because it used the host's Node path instead of the image's `/usr/local/bin/node`.

The agent passes phone-home URL, control-plane origin, and workspace ID as base64url kernel arguments. The M2 init starts a Node one-shot, then execs the image's original `/init`. The one-shot waits until the image has generated SSH host keys and sshd accepts TCP connections, POSTs JSON containing `workspace_id`, `host_public_keys`, and `ssh_host_public_keys`, and atomically writes:

- `/var/lib/blitz/box-credential.json`, mode 0600, with only `box_id`, `access_token`, and `refresh_token`.
- `/var/lib/blitz/origin`, mode 0644, containing `cp_origin`.

On failure it writes `/var/lib/blitz/bootstrap-error.log` mode 0600 and also POSTs an `application/x-www-form-urlencoded` `bootstrap_error` field to the callback.

## Build and test

```sh
go test -race ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o dist/blitz-microvm-agent-linux-amd64 ./cmd/blitz-microvm-agent
```

`integration/live-test.sh` performs the Mac-to-host health/capacity/create/enroll/SSH/surfaces/delete test, verifies idempotent deletion and every resource class, then runs ten create/destroy timing cycles. It requires a temporary local mode-0600 copy of the deployed token through `BLITZ_AGENT_TOKEN_FILE`; neither the script nor agent prints token or key contents.

## M3 vendoring notes

Package files to vendor into `blitz-core`:

- `allocator.go`, `config.go`, `http.go`, `linux_backend.go`, `manager.go`, `state_store.go`, `types.go`
- `cmd/blitz-microvm-agent/main.go` if the standalone daemon entry point is retained
- `guest/microvm-init`, `guest/blitz-microvm-enroll.js`, and `guest/build-rootfs-m2.sh` for the versioned guest image recipe
- `deploy/blitz-microvm-agent.service` and `deploy/config.host.json` as the live-host deployment reference

Config knobs are the API bind/public address, token/state/lab paths, pinned binary/kernel/rootfs paths and version labels, sudo wrapper, network prefix/octet/slot range, SSH port base, sparse upper size, total CPU/RAM, CPU overcommit ratio, maximum VM count, and graceful shutdown timeout. `cpu_overcommit` is a floating-point multiplier; omitted or zero means `1.0`, and fractional effective capacity is rounded down to a whole vCPU. The live M2 values are in `deploy/config.host.json`; the service is installed at `/etc/systemd/system/blitz-microvm-agent.service` and its lab-local state directory is `/home/minjune/blitz-microvm-lab/agent/state`.
