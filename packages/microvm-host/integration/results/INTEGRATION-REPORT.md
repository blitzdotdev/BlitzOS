# M2 live integration report

Date: 2026-08-13 (America/Los_Angeles)  
Agent: `http://192.168.5.25:8086` (Bearer token omitted)  
Guest image: `blitz-box-base-m2-v2.ext4`

## Full lifecycle

- `GET /v1/healthz`: 200, agent `m2`, Firecracker `v1.16.1`, kernel `6.1.155`
- `GET /v1/capacity`: 200, 16 CPU / 24576 MiB / max 10, initially idle
- `POST /v1/vms`: 201, slot 1 / port 22001
- Mac request to SSH: 1048 ms
- Mac request to ports 7443, 7444, and 7445 listening: 1442 ms
- Receiver: enrolled workspace `m2-integration-main`, one `ssh-ed25519` host key
- Guest credential: mode 0600, owner `blitz:blitz`, fields `access_token,box_id,refresh_token`
- Guest origin: mode 0644, owner `blitz:blitz`, expected value
- `DELETE /v1/vms/:id`: 204
- Repeated idempotent delete: 204
- TAP/rules/process/runtime/state audit: clean

## Ten-cycle latency

| Cycle | Request to SSH (ms) | Request to surfaces (ms) |
|---:|---:|---:|
| 1 | 1047 | 1455 |
| 2 | 1035 | 1453 |
| 3 | 1032 | 1426 |
| 4 | 1053 | 1508 |
| 5 | 1072 | 1535 |
| 6 | 1054 | 1543 |
| 7 | 1057 | 1424 |
| 8 | 1069 | 1273 |
| 9 | 1077 | 1348 |
| 10 | 1117 | 1572 |

Interpolated percentiles: SSH p50 1056 ms, p95 1099 ms, max 1117 ms; surfaces p50 1454 ms, p95 1559 ms, max 1572 ms. All ten cycles passed the per-cycle leak audit.

## Live reconcile smoke test

The agent was restarted through the logged sudo wrapper with a VM running. Reconciliation adopted the same Firecracker PID, SSH still worked after restart, and API state remained `running`. Deletion then returned 204 and the resource audit was clean.
