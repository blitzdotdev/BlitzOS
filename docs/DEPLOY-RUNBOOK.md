# Deploy runbook — the hosted deployments

Operational and evergreen. This describes how **this project's own hosted
instances** are deployed. If you run your own copy of BlitzOS, read
[SELF-HOST.md](SELF-HOST.md) instead; it takes a fresh clone to a working
deployment.

Nothing here names an account, a database, a zone, or a customer. Those are
runtime facts. Every one of them is discoverable with the credentials the task
requires, and this document says how to discover each. A runbook that hardcodes
an identifier goes stale silently and leaks whatever it names.

## Two deployments

| Role | What it is for | How it deploys |
|---|---|---|
| **Canary** | Dogfood. Every change lands here first. | Automatically, on every push to `main`. |
| **Client prod** | Real users. | Only from a `v*` git tag, and only after a human approves. |

They live in **separate Cloudflare accounts**, on purpose. Canary is in an
account owned by the maintainer; client prod is in the account that holds the
customer's data. The boundary is the reason a canary mistake cannot reach a
customer. A credential that reaches one must not reach the other, and an
`Authentication error` when a canary credential is pointed at client prod is
the boundary working, not a fault to route around.

Each deployment is one Cloudflare Worker with the same script name, one D1
database, and one R2 bucket. The R2 bucket holds box images **and user
workspace files** (`core/files/dav.ts`, `core/files/folders.ts`), so the two
deployments can never share one.

### Finding out what you are pointed at

```sh
curl -s https://<origin>/version
```

```json
{ "commit": "...", "boxImageRef": "ghcr.io/.../blitz-box@sha256:...", "boxImageTag": "", "migration": "0028_....sql" }
```

That is the authoritative answer to "which commit does this run". With a
deployment's own credentials you can also ask Cloudflare directly:

```sh
npx wrangler whoami --config packages/control-plane/wrangler.toml
npx wrangler deployments list --config packages/control-plane/wrangler.toml
```

## How client prod is deployed

A `v*` tag is the only path. `.github/workflows/release.yml` holds the
credentials and does the whole job, in this order:

1. Builds and pushes the box and broker images for amd64 and arm64.
2. Waits for a human to approve the `production` environment.
3. Writes the deployment config from a repository secret.
4. Pins the box image digest it just built.
5. Refuses to continue unless that image is publicly pullable. VM bootstraps
   pull with no registry login, so an unpullable digest would break every new
   workspace. Failing here leaves the deployment on its previous image.
6. Runs `npm run deploy -w packages/control-plane`, which checks the config,
   lists and applies D1 migrations, builds the webapp, and deploys.
7. Asks the origin which commit it now reports, and fails on disagreement.

So the image and the Worker always ship together, in that order. **Never deploy
the control plane alone for a release, and never publish an image by hand for
one.**

```sh
git tag -a v0.3.0 -m "..." && git push origin v0.3.0
```

Nobody needs production credentials on a laptop, and no workspace, box, or agent
should hold one.

## How canary is deployed

`.github/workflows/canary.yml` runs on every push to `main`. Its `gate` job
checks that canary is configured. Its `image` job derives a release from every
repository input copied by the box Dockerfile, reuses a valid archive already
at that versioned R2 prefix or builds and publishes it, and passes the exact ref,
tag, and digest to `deploy`. The deploy job pins those values and verifies both
the merged commit and box-image tag through `/version`.

It **queues** rather than cancels concurrent runs. A cancelled deploy can leave
migrations applied while the old Worker still serves.

Canary serves its box image as an **R2 archive (mode B)**, out of its own
account; client prod serves it from a registry (mode A), pushed by the tag
workflow. The automatic image job writes only canary's versioned R2 prefix and
never touches the customer's account or GHCR. The full procedure and required
R2 permission are in [BOX-IMAGE.md](BOX-IMAGE.md#automatic-canary-image-publish).
Lody upstream merges follow [LODY-MERGE.md](LODY-MERGE.md); that runbook also
records the temporary gap before the image key includes the vendored tree.

Canary is one shared Worker and the last deploy wins. That is why it deploys
from `main` and not from a laptop: a branch deployed by hand replaces whatever
was there, and the next person debugs a build that matches no commit. This has
happened.

## What GitHub holds

Two environments, configured in repository settings:

| Environment | Protection | Used by |
|---|---|---|
| `canary` | none — deploys unattended | `canary.yml` |
| `production` | required reviewers | `release.yml` |

Secrets, by name only:

| Name | Where | Holds |
|---|---|---|
| `CANARY_WRANGLER_TOML` | `canary` environment | The canary deployment's `wrangler.toml`. |
| `PROD_WRANGLER_TOML` | repository | The client-prod `wrangler.toml`. |
| `CLOUDFLARE_API_TOKEN` | both | A deploy token for the matching account. |

An environment secret overrides a repository secret of the same name, which is
how each deployment gets a token for its own account.

**A stored `wrangler.toml` must contain no comments.** Wrangler's config
patcher refuses to write into a config that has any, and the deploy now writes
to it on every run, not only on the first.

**You do not edit those two secrets when a route or a var is added.** The deploy
fills a stale config in from `wrangler.toml.example` before it deploys, and
names every key it wrote in the log. `assets.run_worker_first` is generated
outright from core's route registrations. What is left in the secrets is what
only they can hold: `account_id`, the D1 `database_id`, the zone ids, `APP_URL`.
Edit them for a new account-specific identifier, and for nothing else.

### What the deploy token needs

Scope Account Resources to the one account that deployment lives in.

| Permission | Level | Needed by |
|---|---|---|
| Workers Scripts | Edit | `deploy`, `secret list`, `rollback` |
| D1 | Edit | `d1 list`, `migrations apply` |
| Workers R2 Storage | Edit | `r2 bucket list` |
| Account Settings | Read | `whoami` |

Editing a token's permissions does not change its value, so the secret needs no
update afterwards.

The Worker also holds a secret named `CLOUDFLARE_API_TOKEN`, which it uses for
workspace tunnels. **That is a different token in a different place.** Do not
replace one with the other.

### Worker secrets are not in GitHub

The Worker secrets listed in [SELF-HOST.md](SELF-HOST.md) already live in
Cloudflare. The deploy only checks that they exist, with `wrangler secret list`,
and refuses to deploy when one is missing. It never sets them, so GitHub never
sees them.

## The three operator commands

Run from the repository root. Each is documented in
[SELF-HOST.md](SELF-HOST.md#operating-the-deployment).

| Command | Answers |
|---|---|
| `npm run config:check -w packages/control-plane` | Does this deployment's config still match `wrangler.toml.example`? |
| `npm run migrations:pending -w packages/control-plane` | What would a deploy apply? |
| `npm run rollback -w packages/control-plane` | What is the previous version? Prints a plan; needs `--yes` to act. |

`config:check` and the migration listing also run inside every deploy, before
anything contacts Cloudflare. Hosted image planning is part of the workflows:
canary's `image` job derives and publishes a content-addressed R2 release, while
the client-prod tag workflow always builds and pins its GHCR image.

`config:check` compares key paths and the entries of `triggers.crons`. It never
reads a value out of the deployment config, so it can run against a real one and
disclose nothing. It does not compare `assets.run_worker_first`: that array is
generated, and the deploy rewrites it on every run.

## Migrations

- The deploy applies them automatically. **Never run
  `wrangler d1 migrations apply` by hand.**
- Wrangler tracks applied migrations **by filename**. Renaming one makes the
  deployment that applied the old name apply the new one as well. Check content
  identity and reconcile the `d1_migrations` rows instead.
- Before merging a migration, check its number against every other open pull
  request and against `main`. Duplicate prefixes resolve by filename sort;
  divergent content under one prefix does not.
- Migrations are forward-only. Rolling the Worker back past one that dropped a
  column breaks the restored code's writes, because that code still targets the
  dropped column.

## Rollback

A Worker version carries its own vars, so a rollback restores the previous
`BOX_IMAGE_REF` along with the previous code. New workspaces return to the old
box image with no second step.

**D1 does not roll back.** Read the migration list before you answer the plan.

There is no traffic ramp. A deploy goes to full traffic at once.

## Gotchas

- **A tag does not wait for CI.** `release.yml` triggers on the tag alone and
  has no dependency on `ci.yml`, so a red build can still reach the approval
  step. This is deliberate — the reviewer is the gate — but it means you must
  check CI on the commit yourself before you approve. It has already shipped a
  release whose commit had a failing test.
- **A bundle hash identifies the webapp build only.** `/assets/index-*.js` is
  derived from webapp source, so a change to a route, a provider, or
  `core/bootstrap.ts` leaves it identical. Two deployments running different
  commits can serve the same bundle name. Ask `/version` instead.
- **Box and broker changes reach new workspaces only.** A box never upgrades in
  place. CLI verbs, gateway routes, rootfs files, and baked agent-rules copies
  all ride the image. Webapp and control-plane changes ride the Worker and reach
  everything at once.
- **A core route absent from `assets.run_worker_first` is served the SPA shell
  with status 200**, not the route. Nothing errors. The list is derived from
  core's route registrations now, and `packages/control-plane/test/route-prefixes.test.ts`
  fails on every push if the generator stops covering a route — so this is caught
  before a deploy rather than by an operator running a check. After adding a
  route, run `npm run routes:sync -w packages/control-plane` to refresh the
  generated copy in `wrangler.toml.example`; that same test names the command.
- **Wrangler 4 auto-loads the repository-root `.env`.** A narrow token there
  hijacks authentication over an interactive login and produces confusing 403s
  on account and D1 calls. Deploying from a scratch worktree avoids it entirely,
  because a worktree has no `.env`.
- **An interactive login may see more than one account.** Keep `account_id`
  pinned in every config so no call can land on the wrong one.
- **Adding a file under `core/` touches three hand-maintained lists**: the module
  manifest, and two module lists with length assertions in the test suite. (The
  route lists came off that tally: the managed worker's prefixes, the dev proxy
  and `assets.run_worker_first` are all derived from the route registrations
  themselves.) Run `BLITZDEV_MANAGED=1 npm test` before pushing one; CI sets that
  variable, so a local run without it skips the gates that catch this.
- **A provider-specific line in the shared bootstrap kills every other
  provider's box.** See [../plans/PROVIDER-BOOTSTRAP.md](../plans/PROVIDER-BOOTSTRAP.md);
  an AWS-only mirror probe failed every Hetzner workspace under `pipefail`.
- **No workspace or agent credential can push the box image to the registry.**
  `write:packages` on that package exists in exactly one place: the
  `GITHUB_TOKEN` inside `release.yml`, which runs only on a `v*` tag push.
  Measured 2026-08-30, the workspace credential `GH_PAT` reads the repository
  and pulls the image manifest — both HTTP 200 — and is refused at
  `POST /v2/.../blobs/uploads/` with HTTP 403; the GitHub App token has no
  package access at all (403, `Resource not accessible by integration`). That
  is the boundary working, not a fault to route around: the same tag that
  would push an image also ships client prod. Canary's automatic `image` job
  publishes its content-addressed release through R2 instead.
- **The `wrangler.toml` in a working checkout is client prod's.**
  `packages/control-plane/scripts/publish-box-image.mjs` always passes
  `--config packages/control-plane/wrangler.toml`, so publishing a canary image
  from a checkout carrying the client-prod config uploads it into the
  customer's bucket. Write a canary-scoped config from `wrangler.toml.example`
  first. That file is gitignored, so it never lands in a commit and never
  travels between the two accounts.

## Rules for agents

Most of these used to depend on discipline. Where a machine now enforces one,
that is said.

1. **Never deploy a branch to canary.** Enforced: canary deploys from `main`
   only. Land the change first.
2. **Never deploy client prod by hand, and never hold a credential that reaches
   it.** Enforced: the only path is a `v*` tag, and the workflow holds the
   credentials.
3. **Cutting a tag is a human decision.** Enforced by the `production`
   environment's required reviewer. An agent may prepare a tag; a person
   approves the deploy.
4. **Identify a deployment by `/version`, never by a bundle hash.** See the
   gotcha above for why the hash is not enough.
5. **Verify the deploy; do not assume it.** Partly enforced: both workflows
   check `/version` after deploying. For anything else a change shipped, fetch
   the live bundle and grep for a string the change introduced. A green deploy
   command proves upload, not content.
6. **Let the canary workflow publish and pin its box image.** The `image` job
   runs before deploy, reuses only a valid matching release, and fails the run
   if planning, building, or publishing fails. See
   [BOX-IMAGE.md](BOX-IMAGE.md#automatic-canary-image-publish).
7. **Never cut a `v*` tag only to refresh canary.** A tag ships client prod to
   real users. The automatic canary image job needs no registry access; no
   workspace or agent credential can push there anyway. The `production`
   reviewer remains the boundary between a tag and a customer deployment.
8. **Say what you could not verify.** A gate that could not run is not a gate
   that passed.
