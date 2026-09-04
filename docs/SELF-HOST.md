# Self-host BlitzOS

This guide takes you from a fresh clone to a working deployment: a control
plane on Cloudflare Workers, Google sign-in, your team in one org, and a first
agent workspace you can open in the browser.

Read it in order. Steps 8–10 (tunnel, box image, provider) each have their own
page; skipping any of them leaves you with a control plane that deploys cleanly
but cannot run a usable workspace.

## Prerequisites

- A Cloudflare account. The control plane is one Worker using D1, R2, cron
  triggers, and static assets. R2 requires a payment method on the account
  even at low usage.
- A domain you can add as an active zone **on that same Cloudflare account**.
  Workspace tunnels need it; without it, cloud-VM workspaces have no browser
  access at all (see [TUNNEL.md](TUNNEL.md)). Any spare domain works; users
  never see these hostnames.
- A Google Cloud project. Google OAuth is the only login method.
- Compute for workspaces: a Hetzner Cloud project (it may hold unrelated
  infrastructure — see step 10), or your own Firecracker host running the
  [microvm-host agent](../packages/microvm-host/README.md).
- Node.js 22.13 or newer, npm, git.
- Docker, for building the box image (on macOS, [Colima](https://github.com/abiosoft/colima) works — see
  [BOX-IMAGE.md](BOX-IMAGE.md)).

Hetzner VMs bill while they exist; every workspace is one VM plus an optional
volume.

## 1. Clone and install

```sh
git clone https://github.com/blitzdotdev/BlitzOS.git
cd BlitzOS
npm ci
```

Notes:

- You do not need to build anything yet. The deploy command in step 4 builds
  the webapp itself (the root `npm run build` exists for CI-style checks).

## 2. Configure the Worker

Generate your config from the template, then edit it:

```sh
npm run config -w packages/control-plane
```

That writes `packages/control-plane/wrangler.toml` with every key from
`wrangler.toml.example` and none of its comments. Do not `cp` the template
instead: step 4 writes your D1 `database_id` into `wrangler.toml`, and wrangler
refuses to patch a config that holds comments. Keep `wrangler.toml.example`
open beside your config — it is where each var is documented.

Your `wrangler.toml` carries your account IDs. Do not commit it.

The generated config is already deployable: every var that can only be
filled in *after* a deploy ships empty, and empty means "that feature is off",
not "refuse to deploy". So you can run step 4 immediately and come back here.

| Var | Required | What it is |
|---|---|---|
| `APP_URL` | after step 4 | Your Worker origin, e.g. `https://blitz-control-plane.<subdomain>.workers.dev`. Request handling derives origins from the incoming request; this var only feeds the teenybase config. Step 4 prints the origin — leave this empty until then, then set it and redeploy. |
| `BOX_IMAGE_REF` | after step 9 | Box image source. A registry reference, or a control-plane URL for R2-hosted archives. Empty deploys fine; workspaces cannot become ready until it points at a published image. Modes and values: [BOX-IMAGE.md](BOX-IMAGE.md). |
| `BOX_IMAGE_TAG` | mode-dependent | Empty for registry mode; the archive's image tag for R2 modes. |
| `BOX_IMAGE_SHA256` | mode-dependent | Empty for registry mode; the archive's SHA-256 for R2 modes. |
| `SESSION_TTL_DAYS` | no | Session cookie lifetime in days, 1–3650. Default 30. |
| `MICROVM_HOSTS` | yes | JSON array of Firecracker hosts. **Set `'[]'` if you have none** — that cleanly disables the microVM provider and removes its token secret from the required set. Each configured host names a `tokenVar`; that Worker secret must then exist and be at least 32 characters with no whitespace, or **every request to the Worker fails with 500**. |
| `HETZNER_MACHINE_TYPES` | no | Comma-separated `type@location` entries for the Hetzner machine catalog, e.g. `cpx21@hil,cx32@fsn1`. Unset or blank keeps the default catalog (`cx23@hel1`, `cx33@hel1`, `cpx21@hil`, `cpx31@hil`). Malformed entries are skipped with a logged warning. |
| `SIGNUP_MODE` | no | `open` (default) or `invite`. In `invite` mode a Google sign-in that would create a new user is refused unless it carries a valid invite (step 7) or the verified bootstrap secret (step 6). Existing users always sign in. |
| `ALLOWED_EMAIL_DOMAINS` | no | Comma-separated email domains, e.g. `example.com,example.org`. When set, **every** sign-in — new or existing user, invited or bootstrap — is refused unless the account's domain is listed. Empty (default) allows any domain. |
| `CLOUDFLARE_ACCOUNT_ID` | for tunnels (step 8) | The account that owns the tunnel zone. |
| `CLOUDFLARE_ZONE_ID` | for tunnels (step 8) | The zone that will hold `ws-<workspace-id>` records. |
| `WORKSPACE_TUNNEL_ZONE` | for tunnels (step 8) | The zone's domain name. Leaving the three tunnel vars empty means cloud-VM workspaces boot but have no terminal, files, or previews in the browser. See [TUNNEL.md](TUNNEL.md). |

The R2 binding (`BOX_IMAGES` → bucket `blitz-box-images`) and the D1 binding
stay as they are; the deploy script creates the database and fills in
`database_id` for you.

Workspace concurrency is capped per organization by `orgs.vm_limit`. New organizations start at 10; self-host operators set the column in D1, while hosted billing writes it through `PUT /orgs/:id/entitlements`.

If your wrangler login can see more than one Cloudflare account, uncomment the
top-level `account_id` and set it to the account this Worker belongs to. The
deploy scopes every wrangler command to it; without it wrangler cannot choose
an account and stops with `More than one account available`.

## 3. Set the secrets

The deploy script refuses to deploy until the first five secrets exist
(`OPERATOR_API_KEY` is optional). Set each one with:

```sh
npx wrangler secret put <NAME> --config packages/control-plane/wrangler.toml
```

| Secret | Where it comes from |
|---|---|
| `CRED_MASTER_KEY` | `openssl rand -base64 32`. Must be base64 of **exactly 32 bytes** — the command above produces exactly that. A malformed value makes every API request return 500. |
| `WEBAPP_TOKEN_SECRET` | `openssl rand -base64 32`. Signs per-request workspace tickets and derives per-workspace guest credentials. Every browser workspace surface returns 503 without it. |
| `GOOGLE_CLIENT_ID` | Google Cloud console (step 5). Use a placeholder like `pending` for the first deploy. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud console (step 5). Placeholder is fine for the first deploy. |
| `HETZNER_API_TOKEN` | Hetzner Cloud console → your project → Security → API tokens → Read & Write. If you run microVM-only, set a random string — the Hetzner catalog then just comes back empty. |
| `OPERATOR_API_KEY` | Optional. `openssl rand -hex 32`. Only consulted by the `?bootstrap=` flow in step 6; the deploy script does not require it, and a fresh deployment never needs it. |

If `MICROVM_HOSTS` lists hosts, each host's `tokenVar` (for example
`MICROVM_LAB_TOKEN`) is also required: `openssl rand -hex 32`, and the same
value goes into the host's token file (`/etc/blitz/microvm-agent-token`).

`JWT_SECRET_MAIN` is **not** needed, and no code references it any more.
teenybase only mints or verifies its own JWTs for tables that declare an auth
extension; this deployment declares none and authenticates with opaque session
cookies instead, so the setting was removed rather than documented.

## 4. First deploy

```sh
npm run deploy -w packages/control-plane
```

The deploy command is prompt-free and repeatable. It checks wrangler auth,
creates the D1 database if absent and writes its ID into your `wrangler.toml`,
applies migrations, creates the `blitz-box-images` R2 bucket if absent,
verifies the required secret names, builds the webapp, and deploys. If it
reports missing secrets, set them and rerun the same command.

When it finishes, note the Worker URL it prints — that is your origin. Put it
in `APP_URL` in step 2's table, register it with Google in step 5, then run
the same deploy command again.

## 5. Google OAuth

Google sign-in is the only login method, and the redirect URI is derived from
the request origin — so you need the origin from step 4 before you can
register the OAuth client. That is why the first deploy runs with placeholder
Google secrets.

1. In [console.cloud.google.com](https://console.cloud.google.com), open
   **APIs & Services → OAuth consent screen** and configure it. Choose
   **Internal** if your org uses Google Workspace — that alone restricts
   sign-in to your domain. Otherwise choose **External**.
2. The app uses only the basic scopes `openid`, `email`, `profile`. No
   sensitive scopes, no verification review needed.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
4. Add exactly one authorized redirect URI:

   ```text
   <your-worker-origin>/auth/google/callback
   ```

   For example
   `https://blitz-control-plane.example.workers.dev/auth/google/callback`.
   The match is exact — scheme, host, and path.
5. Copy the client ID and secret into the two Worker secrets, then redeploy:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID --config packages/control-plane/wrangler.toml
   npx wrangler secret put GOOGLE_CLIENT_SECRET --config packages/control-plane/wrangler.toml
   npm run deploy -w packages/control-plane
   ```

## 6. First login and org creation

Open your Worker URL and sign in with Google. Create an organization when
prompted — you become its admin. That is the whole first-run story on a fresh
database.

The `?bootstrap=` URL exists for migrating a **pre-identity database** (one
with legacy rows owned by the old `operator` principal). Sign in once at
`/auth/google/start?bootstrap=<OPERATOR_API_KEY>`: the verified secret makes
that Google account the platform operator and adopts the legacy rows into its
org. Promotion is first-operator-only — it works for a brand-new or an
already-existing account, but only while the deployment has no platform
operator yet; once one exists, the parameter does nothing. A wrong or unset
secret refuses the sign-in. The `ALLOWED_EMAIL_DOMAINS` allowlist still
applies even to bootstrap; in `invite` mode the verified secret stands in for
an invite. On a fresh deployment, ignore all of this.

## 7. Invite your team

Signed in as an org admin, create invite links from the members settings in
the webapp and send them to teammates. An invite link signs the recipient in
with Google and lands them in your org.

**Warning — signup is open by default.** Any Google account that can reach
your Worker URL can sign in, create its own org, and provision workspaces on
your cloud accounts, up to the per-org VM limit. Gate it with the two Worker
vars from step 2:

- `SIGNUP_MODE = "invite"` — new accounts get in only through an invite link
  (or the one-time bootstrap secret); existing users keep signing in.
- `ALLOWED_EMAIL_DOMAINS = "example.com"` — every sign-in, including existing
  users, must come from a listed domain.

Extra layers if you want them: put Cloudflare Access (or your own SSO proxy)
in front of the Worker, or use an **Internal** Google consent screen
(Workspace orgs only), which restricts sign-in to your domain at Google's
side.

## 8. Workspace tunnels

Follow [TUNNEL.md](TUNNEL.md): add a zone, mint a scoped API token, set the
three `CLOUDFLARE_*`/`WORKSPACE_TUNNEL_ZONE` vars, and redeploy.

Do not skip this for cloud VMs. Every active browser surface — terminal, files,
and previews — routes through the control plane's tunnel to the workspace. Without
it, a Hetzner workspace boots, reports `ready`, and then every surface returns
`503 workspace has no webapp tunnel`. MicroVM workspaces are the exception:
their host agent carries this traffic itself.

## 9. Box image

Follow [BOX-IMAGE.md](BOX-IMAGE.md). Every workspace VM pulls or downloads the
box image named by `BOX_IMAGE_REF` at boot; until you publish one and point
the vars at it, workspaces cannot become ready.

## 10. Provider

**Hetzner.** The Read & Write token from step 3 is all the code needs. The
project may be shared with unrelated infrastructure: no janitor selects
resources by label. `runOrphanSweep` reads VM IDs out of this deployment's own
`workspaces` table and destroys those IDs only, and the volume routes match
every Hetzner volume against this deployment's `volume_ownership` table before
listing or deleting it, so a server or volume this control plane did not
create is never touched. Workspace servers do carry `blitz-purpose=workspace`
and `blitz-workspace=<workspace-id>` labels, for your own filtering.

`CLOUD_WORKSPACE_CREDENTIAL_POLICY` defaults to `deployment-fallback`. Every
organization first uses its validated provider key, then falls back to this
deployment token. A self-host upgrade therefore needs no config change.

A hosted deployment must set the policy to `byok-required`. Every organization,
including one that contains a platform operator, must then validate its own
provider key before its members can see or create new cloud machines. Existing
workspaces and volumes keep using the credential source stored on their row;
legacy rows with no source recorded remain pinned to the deployment token.

The machine-type catalog offered in the create dialog defaults to `cx23@hel1`,
`cx33@hel1`, `cpx21@hil`, and `cpx31@hil`; set the `HETZNER_MACHINE_TYPES` var
(comma-separated `type@location`) to offer the types and locations your project
can actually get. Types with no availability in their location produce an empty
catalog.

**Firecracker (microVM).** Run the
[microvm-host agent](../packages/microvm-host/README.md) on your own hardware,
list it in `MICROVM_HOSTS`, and set its token secret. The guest kernel, base
rootfs, and Firecracker binary are operator-supplied; the microvm-host README
describes the layout. MicroVM workspaces need no tunnel but have no volumes.

## 11. Create a workspace

In the webapp, create a workspace. Success looks like:

- the workspace reaches `ready`;
- for a cloud VM, a proxied DNS record `ws-<workspace-id>.<your-zone>`
  appears in the tunnel zone;
- the terminal tab opens a shell, and files and previews load.

If all of that works, the deployment is complete.

## Operating the deployment

Four commands answer the questions that come up after the first deploy. Run
each one from the repository root.

### Ask a deployment what it runs

```sh
curl -s https://<your-origin>/version
```

```json
{ "commit": "0bd4a8b...", "boxImageRef": "ghcr.io/...@sha256:...", "boxImageTag": "", "migration": "0028_drop_generic_connections.sql" }
```

The deploy records the commit it shipped, so you never have to guess. Do not
identify a deployment by its `/assets/index-*.js` bundle hash: that hash is
derived from the webapp source only, and a change to a route, a provider, or
`core/bootstrap.ts` leaves it identical.

### Check the config against the template

```sh
npm run config:check -w packages/control-plane
```

`wrangler.toml` is per-deployment and gitignored, and `npm run config` writes it
only once. When `wrangler.toml.example` gains a var or a route, your config
keeps the old shape and the next deploy succeeds with a route that 404s. This
command compares key paths, never values, and the deploy runs it for you.

### See migrations before they apply

```sh
npm run migrations:pending -w packages/control-plane
```

The deploy applies migrations automatically and now prints this list first.

### Decide whether the box image needs a rebuild

```sh
npm run box-image:check -w packages/control-plane -- --url https://<your-origin>
```

The Dockerfile's repository inputs ride the image, and a box never upgrades in
place, so those changes reach new workspaces only. Everything else rides the
Worker. Exit code 2 means a rebuild is due. This remains a self-host operator
check; the hosted canary performs content-derived image planning automatically.

### Roll back

```sh
npm run rollback -w packages/control-plane          # prints the plan
npm run rollback -w packages/control-plane -- --yes # runs it
```

A Worker version carries its own vars, so the rollback restores the previous
`BOX_IMAGE_REF` with the previous code.

**D1 does not roll back.** Migrations are forward-only. If a migration since the
target version dropped a column, the restored code will write to a column that
no longer exists. Check the migration list before you answer.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every API request returns 500 | `CRED_MASTER_KEY` is not base64 of exactly 32 bytes, or a `MICROVM_*_TOKEN` is shorter than 32 characters or contains whitespace | Regenerate with `openssl rand -base64 32` (or `-hex 32` for the host token). No microVM hosts? Set `MICROVM_HOSTS = '[]'`. |
| Every API request **and every cron** returns 500 right after a var edit | `SIGNUP_MODE` is not exactly `open` or `invite` (`invite-only` is the common typo), or an `ALLOWED_EMAIL_DOMAINS` entry is not a bare domain (`alice@example.com` and `gmail` are both rejected) | Fix the value in `wrangler.toml` and redeploy. The deploy command refuses both before it deploys, so a Worker in this state was deployed by hand. |
| Machine-type list is empty in the create dialog | Bad `HETZNER_API_TOKEN`, or the catalog's types have no availability in their location | Verify the token is Read & Write on the right project; set `HETZNER_MACHINE_TYPES` to types and locations your project can get. |
| `503 workspace has no webapp tunnel` on terminal/files/previews | Tunnel vars were unset when the workspace was created | Do step 8, then recreate the workspace. |
| `503 workspace webApp authentication is unavailable` | `WEBAPP_TOKEN_SECRET` missing | Set it and redeploy. |
| Google login fails with a redirect error | Redirect URI mismatch | Register exactly `<origin>/auth/google/callback`. |
| Workspace stuck in `creating` | The VM cannot fetch the box image | Check `BOX_IMAGE_*` against [BOX-IMAGE.md](BOX-IMAGE.md); registry images must be publicly pullable. |
