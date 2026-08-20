# broker

Broker images are not published yet; build the image locally before using the
commands below.

```sh
docker volume create blitz-broker
docker pull ghcr.io/blitzdotdev/blitz-broker@sha256:<image-digest>
docker run -d --name blitz-broker --restart unless-stopped --env-file env.defaults -p 2222:22 -v blitz-broker:/var/lib/blitz-broker ghcr.io/blitzdotdev/blitz-broker@sha256:<image-digest>
docker exec blitz-broker blitz-broker enroll --origin https://control.example --host broker.example --port 2222
```

## Provisioning a broker box

`deploy/provision-broker.sh` runs in **two passes**, with a human between them,
because every workspace **pins** this box's SSH host key: the control plane must
have that key on file before anything is told to trust the broker.

```sh
BROKER_HOST=operator@broker.example \
CONTROL_PLANE_ORIGIN=https://control.example \
BROKER_IMAGE=ghcr.io/blitzdotdev/blitz-broker@sha256:<image-digest> \
SSH_PORT=2222 \
  packages/broker/deploy/provision-broker.sh prepare

# ... enroll and approve, see below ...

BROKER_HOST=operator@broker.example SSH_PORT=2222 \
  packages/broker/deploy/provision-broker.sh verify
```

`BROKER_HOST` is the SSH target of the **Docker host** (`user@host` or `host`).
The operator supplies that machine; neither pass creates or changes provider
resources. `SSH_HOST` overrides the public address workspaces dial and otherwise
defaults to the host part of `BROKER_HOST`; `SSH_PORT` is the published port and
defaults to `22`. `BROKER_CONTAINER` and `BROKER_VOLUME` both default to
`blitz-broker`. Both passes accept `--dry-run`, which prints what the pass would
do and touches nothing.

1. **`prepare`.** Creates the state volume, starts the container with
   `--restart unless-stopped`, waits for `entrypoint.sh` to generate the SSH host
   key on the volume, and prints that key plus the exact `blitz-broker enroll`
   command for this host and port. Re-running it is safe: an existing container
   is left on the image it was created with.
2. **Enroll, then approve.** Run the printed command on the host. It prints a
   verification URL and a user code, waits for you to approve it in a browser,
   and then registers `host`, `port` and the SSH host key itself over
   `PUT /boxes/:id/broker` — which is what creates the `broker_boxes` row. There
   is deliberately no HTTP endpoint that creates that row without a human
   approving a device code, and there is no self-serve broker creation.
3. **`verify`.** Installs `deploy/verify-broker-box.sh` on the host, runs it as
   root, and only then prints the host, port and host key to match against the
   registered row. The gate runs **last**, and its exit status is load-bearing:
   a box that does not verify fails the whole run before any success report is
   printed.

The state volume holds the SSH host key. Keep it: re-creating it mints a new key
and every already-enrolled workspace's pin breaks.

Nothing in this flow carries a secret. Production used a pre-shared per-box token
and a hand-executed `wrangler d1 execute` INSERT; the device flow replaces both,
so there is no env file to render, nothing to copy to the host, and nothing to
keep out of a command line. The box credential the flow writes onto the state
volume is never read by these scripts — the gate proves it exists without
opening it.

### The verify gate

`deploy/verify-broker-box.sh` runs on the Docker host as root, takes no address,
and writes nothing. Every check in it is a way a real box has failed:

- the Docker daemon is active and the container is running under a restart
  policy that brings it back;
- `sshd` is alive **inside** the container — it is a background child of the
  entrypoint, so a dead `sshd` leaves the container "running" and answering
  nothing;
- the published port is bound according to the **kernel** (`ss -H -ltn`), not
  according to Docker, because the failure this gate exists for is a listener
  that is up but bound to nothing reachable;
- PID 1 is `blitz-broker sync`, and the box holds a control-plane credential and
  has run a quiet window of polls — together, proof the control plane accepted
  this box;
- the `authorized_keys` directory matches `sshd_config`'s `AuthorizedKeysFile`
  and is `root:root` `0755`, because `StrictModes yes` makes `sshd` reject every
  member key otherwise;
- the host clock is UTC and NTP-synchronised. The container shares it, and a
  wrong clock breaks TLS to the control plane and every token lifetime.

`deploy/provision-broker.test.sh` runs both scripts against fake
`docker`/`systemctl`/`ss`/`timedatectl`/`ssh`/`scp` on a temporary `PATH`. It
takes no real host: `sh packages/broker/deploy/provision-broker.test.sh`.

### Decisions

- **Broker boxes are shared across orgs.** One box holds many members' credential
  homes, isolated by Unix user and by the per-key `command=`/`restrict` line
  `blitz-broker sync` renders.
- **`member_cap` (default 25) is a blast-radius cap, not a capacity number.** It
  is how many identities one broker compromise takes with it, counted in
  distinct principals rather than boxes, and it is the reason a member's second
  workspace sticks to the broker that already holds their credential instead of
  being load-balanced away from it.
- **Zero `broker_boxes` rows means the feature is OFF.** Workspace enrolment
  treats "no broker" and "every broker full" as the same clean skip: leave the
  workspace signed out and wired to nothing, and exit 0.
- **There is no autoscaler.** A second broker is a human running both passes
  against a different `BROKER_HOST`. An automatic create path on a box class that
  sits outside every reaper, with no drain and no delete path, is a leak
  generator.
