# control-plane

The workspace engine for fleets on your cloud.

Self-hosters set `APP_URL` to their Worker origin.

- The workspace API: create (machine shape + ssh pubkey + optional volume +
  optional user-data) · poll (the only authoritative read) · destroy
  (idempotent, tombstone). The workspace view carries the public SSH endpoint
  and pinned host key.
- The server owns the workspace view. Clients render it. Monotonic revision.
- Two provider seams: `VmProvider` and `VolumeProvider`. Hetzner, AWS
  (EC2/EBS), and microVM pool adapters are included. Your cloud = one adapter
  file, not a fork.
- Volumes are raw cloud primitives, passed through — no shadow tables. A
  volume survives workspace destroy.
- Readiness = the VM bootstrap posts box host keys to a single-use capability
  URL only after the container is healthy. The response is saved as the box
  credential, so hosted enrollment needs no human.
- Sessions: operator key → opaque server session.
- The broker registry: pubkeys and routing only, never a credential. Broker
  boxes pull their own member slice; no box can list the fleet.

## Standalone deployment

Use a dedicated Hetzner project: janitor operations must never share a project
with other infrastructure. The Worker is wired through `teenyHono`,
teenybase's raw D1 wrapper, and the relative-import-only `core/`
implementation. The live D1 migration remains Wrangler-owned during this
cutover (`teenybase.ts` deliberately has `tables: []`). Deploy from the
repository root with:

```sh
npm run deploy -w packages/control-plane
```

The command is prompt-free and repeatable. It checks Wrangler authentication,
looks up the configured D1 name using JSON output, creates it if absent,
patches the exact `DB` binding through Wrangler's structured config helper,
applies remote migrations, checks required secret names without reading their
values, builds the webApp, and deploys. The `blitz-box-images` R2 bucket must
already exist; create it once with
`npx wrangler r2 bucket create blitz-box-images` if needed.

If the secret check fails, set only the reported missing secrets and rerun the
same deploy command:

```sh
npx wrangler secret put HETZNER_API_TOKEN --config packages/control-plane/wrangler.toml
npx wrangler secret put OPERATOR_API_KEY --config packages/control-plane/wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_ID --config packages/control-plane/wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config packages/control-plane/wrangler.toml
npx wrangler secret put WEBAPP_TOKEN_SECRET --config packages/control-plane/wrangler.toml
```

`WEBAPP_TOKEN_SECRET` derives the per-workspace guest credential and signs
the per-request webApp tickets. Every webApp surface request 503s without
it — it is required for tunnel and microVM deployments alike.

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` configure Google OAuth.
`OPERATOR_API_KEY` is no longer an API credential: it is only the bootstrap
secret. The first admin signs in at
`/auth/google/start?bootstrap=<OPERATOR_API_KEY>` to claim the legacy
operator-owned rows and become the platform operator.

`MICROVM_HOSTS` is a non-secret JSON array. The primary production shape is a
pinned host with exactly `name`, `url`, and `tokenVar`; `tokenVar` names a
Worker secret binding whose value is the host agent Bearer token. Use this for
the intended large AWS, Hetzner, or bare-metal host at a stable URL:

```toml
MICROVM_HOSTS = '[{"name":"lab","url":"https://microvm-lab.example","tokenVar":"MICROVM_LAB_TOKEN"}]'
```

Only a home-lab/NAT host using a rotating Cloudflare Quick Tunnel should omit
`url` and instead set exactly `{name,tokenVar,dynamic:true}`. That host reports
its current HTTPS URL to `POST /hosts/:name/register` with its own Bearer token.
Pinned hosts reject registration and are refreshed into D1 from configuration
on every request, so the dynamic path does not alter their behavior.

Set the referenced value as a secret, never inside `MICROVM_HOSTS`:

```sh
npx wrangler secret put MICROVM_LAB_TOKEN --config packages/control-plane/wrangler.toml
```

Machine IDs are `mv-<cpu>c<memGb>g@<hostName>`. The included pool sizes are
`2c2g` and `2c4g`; they appear only while the selected host's live
`/v1/capacity` response has enough CPU, memory, and a VM slot.

## AWS provider (EC2 and EBS)

The AWS adapter is optional and joins the VM registry only when its variables
are set; a deployment that sets none of them keeps exactly the providers it had.
Setting some but not all of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_REGION` throws at startup rather than silently dropping the provider.

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID --config packages/control-plane/wrangler.toml
npx wrangler secret put AWS_SECRET_ACCESS_KEY --config packages/control-plane/wrangler.toml
```

Set `AWS_REGION` in `wrangler.toml` `[vars]`, plus the optional
`AWS_IMAGE_ID`, `AWS_SUBNET_ID`, and `AWS_SECURITY_GROUP_IDS`.

Machine IDs are `aws-<ec2InstanceType>@<region>`, for example
`aws-t3.medium@us-east-1`; the curated catalog is `t3.medium`, `t3.large`,
`m6i.large`, and `m6i.xlarge`, x86_64 only because the published box image is an
amd64 tag. VM IDs are the raw EC2 instance ID (`i-` plus 8 or 17 hex digits),
which cannot collide with Hetzner's numeric IDs or microVM's `microvm:` IDs.
Requests are signed with a hand-rolled SigV4 on Web Crypto — the control-plane
core may not import npm packages — and EC2's XML replies are read by a small
targeted scanner, both under `core/compute/`.

EC2 accepts at most 16 KiB (16,384 bytes) of user data in raw form, before
base64 encoding: half of Hetzner's budget, of which the generated bootstrap
already spends roughly 12-13 KiB. Sizing the caller payload accordingly matters
more here than on Hetzner.

Reachability is the operator's job. `AWS_SECURITY_GROUP_IDS` must name a group
that admits inbound TCP 22 (the box container binds host port 22; the host's own
sshd moves to 2222) and allows outbound HTTPS for phone-home, the box image
download, and the workspace tunnel. Leaving it empty falls back to the VPC
default group, which refuses inbound SSH, so the workspace will bootstrap and
then be unreachable. With `AWS_SUBNET_ID` set the launch explicitly requests a
public IPv4; without it the instance inherits the default subnet's auto-assign
setting. Two AWS behaviours differ from Hetzner and are not papered over: EC2
releases the auto-assigned public IPv4 when an instance stops, so a stopped
workspace's stored SSH host goes stale, and an EBS volume can only attach inside
its own availability zone, which is why `AWS_SUBNET_ID` also pins the zone.

All volume operations still route to Hetzner: `CoreRuntime.providers.volume`
holds a single adapter, so `AwsProvider`'s EBS implementation is available and
tested but not yet reachable from the `/volumes` routes.

Session cookies expire after 30 days by default. Set `SESSION_TTL_DAYS` to an
integer from 1 through 3650 to override that lifetime. Expired sessions return
401 and are deleted by both scheduled and lazy janitors.

Workspace creation defaults to 10 concurrent workspaces per principal;
`MAX_CONCURRENT_WORKSPACES` accepts an integer from 1 through 1000. Concurrent
means every non-terminal lifecycle state: `creating`, `ready`, `destroying`,
and `error`. Only `destroyed` tombstones do not count.

Hetzner accepts at most 32 KiB (32,768 bytes) of `user_data`. The control plane
measures UTF-8 bytes and enforces this exact formula before calling the
provider: `caller userData bytes + generated MIME/cloud-config/bootstrap bytes
<= 32768`. Equivalently, the maximum caller payload for a request is `32768 -
generated bytes`; the generated size varies with that request's keys, URLs,
image settings, MIME boundary, and capability token.

Set the non-secret image vars in `wrangler.toml` using one of these modes:

- Registry: `BOX_IMAGE_REF` is an immutable Docker image reference;
  `BOX_IMAGE_TAG` and `BOX_IMAGE_SHA256` are empty strings.
- Single archive: upload a gzipped `docker save` archive at R2 key `box-image`,
  set `BOX_IMAGE_REF` to the deployed control-plane URL ending `/box-image`,
  `BOX_IMAGE_TAG` to the tag contained in the archive, and
  `BOX_IMAGE_SHA256` to the archive's SHA-256 hex digest.
- Multipart archive: upload the manifest at R2 key
  `box-image/manifest.json` and every part at `box-image/<name>`. Set
  `BOX_IMAGE_REF` to the deployed URL ending `/box-image/manifest.json`,
  `BOX_IMAGE_TAG` to the manifest's `imageTag`, and `BOX_IMAGE_SHA256` to the
  concatenated gzip archive digest (which must also equal `totalSha256`). The
  manifest shape is
  `{"parts":[{"name":"part-000","sha256":"<64 hex>"}],"totalSha256":"<64 hex>","imageTag":"blitz-box:<tag>"}`.

The `BOX_IMAGES` binding must target the `blitz-box-images` bucket. Both image
routes are intentionally public. Both crons finish orphaned destroy work and
mark stale creates as errors.

Do not use `teeny deploy` for Target A until the existing live D1 has a
separately reviewed teeny migration baseline. Library users install the core
routes on a teenybase-owned router with `installControlPlaneRoutes` and supply
a `RuntimeFactory`. Design records: `TODO.md` and `../../plans/PORT-DESIGN.md`.
