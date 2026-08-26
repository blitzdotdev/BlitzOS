# Deploy runbook — canary and client prod

Operational, evergreen. For the hosted instances run from this repo. Written
2026-08-22. Self-hosters use `docs/SELF-HOST.md` instead; this file is about
OUR two deployments.

## Topology

| Instance | URL | Account | Role |
|---|---|---|---|
| Canary | blitz-control-plane.minjunesv0.workers.dev | minjunesv0 (53a144…) | dogfood; every main deploy lands here FIRST |
| Client prod | blitz-control-plane.blitzapp.workers.dev | blitzapp (d25a778b…) | a real client uses it; deploy only after the canary passes |

`blitzos.app` serves a static marketing page, not the app.

## Config homes (wrangler.toml is gitignored, per-deployment)

- **Canary**: `packages/control-plane/wrangler.toml` in the MAIN checkout
  (`/Users/minjunes/blitz-core`). Since 2026-08-22 it lives there
  permanently; before that it lived only in the `blitz-core-aws` worktree.
- **Client prod**: the `PROD_WRANGLER_TOML` GitHub Actions secret. The
  `release.yml` workflow writes it over `packages/control-plane/wrangler.toml`
  and deploys on `v*` tags. It targets blitzapp — correct; never point it at
  the canary.
- When `wrangler.toml.example` gains structure (new `run_worker_first`
  entries, `[[rules]]` blocks, new `[vars]`), BOTH homes must be re-patched
  by hand. A green deploy with a stale toml 404s new routes or fails the
  worker build.

## The standard sequence

1. Merge to main. CI must be green on the merge commit.
2. Deploy the canary from the main checkout:
   `npm run deploy -w packages/control-plane`.
   The script validates vars, checks worker secrets exist, **auto-applies
   unapplied D1 migrations by filename**, builds the webapp into the worker
   assets, and deploys.
3. Verify the canary (checklist below).
4. Only then deploy client prod: cut a `v*` tag (release.yml builds+pushes
   box/broker images, pins the box digest, deploys blitzapp), or run the
   same npm deploy with the prod toml if a tag is not wanted.
5. Box-image-dependent changes reach only NEW workspaces (boxes never
   upgrade in place). CLI verbs, gateway routes, rootfs files, and baked
   agent-rules copies all ride the image; webapp/CP changes ride the worker.

## Migration rules

- The deploy script applies migrations automatically. NEVER run
  `wrangler d1 migrations apply` by hand, and never deploy an instance whose
  `d1_migrations` history diverged from the repo without reconciling first.
- Wrangler tracks applied migrations BY FILENAME. Renaming a migration means
  the instance that applied the old name will re-apply the new one — check
  content identity and reconcile the `d1_migrations` rows instead
  (INSERT new names, DELETE old names). Precedent: the 0017–0020 →
  0022–0025 connections rename, reconciled on the canary 2026-08-22 per
  PR #11's deploy caveat.
- Before merging a PR with migrations, check the numbers against BOTH other
  open PRs and main — duplicate prefixes resolve by filename sort, but
  divergent-content collisions are forbidden.
- Rollback caution: rolling the worker back past a column-dropping migration
  breaks the old code's writes (it targets the dropped column). Check the
  PR's Deploy section; restore the column or roll forward.

## Canary verification checklist (after every deploy)

- `npx wrangler deployments list | head` — the new version is live.
- Fetch `/` and pull the `/assets/index-*.js` bundle; grep for the features
  the deploy shipped (e.g. `workspace-recipes`, `Startup script`,
  `Agent rules`, `teenyapp`).
- `npx wrangler d1 execute blitz-control-plane --remote --command
  "SELECT name FROM d1_migrations ORDER BY id" --json` — matches the repo's
  migrations dir (modulo documented renames).
- Log in, open `/templates/new`, create a workspace, open a terminal.
- Feature-specific spot checks per the shipped PRs.

## Gotchas

- **Wrangler 4.x auto-loads the repo-root `.env`.** The deploy script spawns
  wrangler with cwd = repo root, so `.env`'s `CLOUDFLARE_API_TOKEN` (a
  narrow token) hijacks auth over the OAuth login and 403s account/D1 calls.
  Workaround: a PATH shim appending `--env-file /dev/null` to every wrangler
  call — but the shim DOES NOT survive `npm run` (npm prepends
  `node_modules/.bin`, shadowing it; confirmed 2026-08-23). Invoke
  `node packages/control-plane/scripts/deploy.mjs` directly with the shim on
  PATH instead. Durable fix: rename that variable in `.env`.
- The OAuth login sees BOTH accounts. Always keep `account_id` pinned in
  the toml so no call can land on the client account.
- Wrangler's config patcher rejects toml comments — keep the per-instance
  tomls comment-free.

## Instance-state notes (append-only)

- 2026-08-22: canary `d1_migrations` reconciliation for the connections
  rename (0022–0025 marked applied, old 0017–0020 rows deleted) — performed,
  read-back verified. Client prod never needed it (main-lineage history).
- 2026-08-22: canary deployed main `5a20132` (version `e950c0bd`, 17:10 UTC).
  Seven migrations applied cleanly (0017–0021, 0026, 0027). Bundle verified:
  recipes, startup script, agent rules, org default, teenyapp, connections
  all present; `/workspace-recipes` routes to the worker. The canary
  `wrangler.toml` now lives in the main checkout (account_id pinned, new
  worker-first routes, Text rule added).
- Broker boxes: none provisioned on either instance. Template env vars +
  startup scripts silently no-op until one exists
  (`packages/broker/deploy/OPS.md`).
- 2026-08-23: canary deployed main `695adca` (version `4076e9c9`, 22:19 UTC)
  after the #20 → #21 → #23 chain. Migration `0028` applied (generic rows
  deleted; 5 non-generic connections preserved). Box image now pins the
  GHCR digest of `blitz-box:canary-695adca` (multi-arch, provenance
  attested, publicly pullable) — the canary switched from Mode B (archive
  via the client-prod worker) to Mode A (`docker pull` from GHCR), removing
  its cross-instance dependency. Client prod still runs Mode B until a
  `v*` tag ships. GHCR pushes need `gh auth refresh -s write:packages`
  (browser flow, operator-only); docker was logged out of ghcr.io after.
- 2026-08-24: canary deployed main `315baf0` (PR #25). Two deploys, both
  with zero migrations. Worker-only first (version `1ef5279a`, 00:21 UTC)
  to ship the webapp input-queue + url-hold + OSC-8 fixes to EXISTING
  workspaces; then the box re-pin (version `14d67dbc`, 00:25 UTC). Box
  image `blitz-box:canary-315baf0`, digest
  `sha256:f71d1b4f5bbee4e5a0914cf0e5a1d9b459129f04ab47cbeb01c78acc3cddf5e0`
  (linux/amd64 + linux/arm64, provenance attested, anonymous manifest 200).
  Built on the reused `blitzcanary` buildx builder inside colima; amd64
  emulation comes from colima's `rosetta` binfmt entry, so `buildx ls`
  under-reports the platform list — pass `--platform` explicitly and the
  build still works.
- 2026-08-24: login-bug root cause fixed. Bisect (GLM session) pinned first-bad
  box commit `f30d1c1` (#3): `install -D` in `blitz-init-state` left
  `~/.claude`/`~/.codex` root-owned, so claude could not persist
  `~/.claude/.credentials.json` after OAuth (paste + exchange were clean).
  Fix = PR #30 (`86c59b8`). Canary worker `8939a6ec` pins
  `blitz-box:canary-86c59b8`, digest `sha256:daff2a7d63910a353eff8f61…`.
  Interim pins that session: Mode B `20260818a` (fff92bcc), then
  `canary-0f84cf4` (ebea9f51, last-good). Fix reaches NEW workspaces only;
  a rebooted box on the fixed image self-heals ownership.
- 2026-08-24: Remote Control returned as an in-image s6 service (PR #32,
  `abfd252`). Canary worker `57390e4a` pins `blitz-box:canary-abfd252`,
  digest `sha256:99d01e36bdbc3a1b9e6e64f7507e891f…`. Two facts the parked
  bootstrap version had wrong: `claude remote-control` is not a command in
  2.1.228 (it is `claude rc`), and its `.credentials.json` login guard could
  never fire while `~/.claude` was root-owned. NEW workspaces only.
- 2026-08-24: Remote Control consent fix (PR #35, `267042d`). Canary worker
  `e1633805` pins `blitz-box:canary-267042d`, digest
  `sha256:5cf53b3c6f9970d0e8758dc10f3b71f5…`. `claude rc` asks
  `Enable Remote Control? (y/n)` once per box; the service answered nothing and
  restarted into the same question every five seconds. It now sends `y` while
  claude has not recorded `remoteDialogSeen`, logs to
  `/var/lib/blitz/remote-control.log`, and grows its restart delay. NEW
  workspaces only. CI note: `control-plane test/files.test.ts` flaked on a
  5s timeout during this PR; it passes locally in 2.4s and on re-run.
- 2026-08-24: Remote Control workspace-trust fix (PR #37, `b309cbb`). Canary
  worker `2c5d54cb` pins `blitz-box:canary-b309cbb`, digest
  `sha256:792130f584a8bd7089c768d5f325147e…`. s6 starts a service in its own
  service directory, so claude judged trust for
  `/run/s6-rc:s6-rc-init:<random>/servicedirs/remote-control` — a path that is
  new on every boot. The run now enters `/workspace` first, matching
  `blitz-term`. NEW workspaces only. The three Remote Control faults were found
  in order: no command (#32), no consent answer (#35), wrong directory (#37);
  the log added in #35 is what made the last one visible.
- Box image: the canary pins whatever ref its toml carried from the
  aws-worktree era. Repo cloning needs an image with `blitz-cred` +
  `/etc/gitconfig` (v0.1.0+); verify on the first repo-template workspace
  and re-pin if needed.
- 2026-08-22: first-party GitHub App key (blitzosauth, PKCS#8-converted,
  verified valid) stashed at `~/.blitz/github-app-private-key.pem`
  (mode 600, outside the repo). The first-party-app switch was PARKED
  2026-08-23 — per-org app config stays. The key stays stashed in case the
  idea returns.

- 2026-08-25: canary worker `87f4d198` at main `54ef642`. Four worker-only
  changes since the pull-only deploy, no migrations, no image rebuild
  (nothing under `packages/box` or `packages/broker` changed, so the
  `canary-722bd0c` pin still stands). Shipped: provider failures now show
  beside the machines that did arrive (#41), Helsinki `cx23`/`cx33` in the
  Hetzner default catalog (#42), each VM provider supplies its own bootstrap
  apt setup (#43), and the monthly price prints in each machine card (#44).
  Also this session: canary's `HETZNER_API_TOKEN` was replaced with a working
  key. It had never been valid, so all 35 earlier canary workspaces ran on
  AWS, which is why bootstrap's AWS-only EC2 mirror probe went unnoticed until
  the first Hetzner box died on it. Decision record for #43:
  `plans/PROVIDER-BOOTSTRAP.md`.

- 2026-08-25: two canary deploys. Worker `9335e623` pinned
  `blitz-box:canary-4611cc4` (digest `sha256:9e2aecf9b01a2e7b…`) for the
  Remote Control permission mode (#46) and the create-dialog fixes (#45).
  Worker `2b502829` then shipped the box hostname change (#47), worker-only —
  nothing under `packages/box` changed, so the pin carried over. `#36` (codex
  device auth) rode along from another session, unreviewed here.
  Owner-confirmed working: #45, #46, #47.
  Remote Control naming, settled by inspecting the vendor binary: the
  claude.ai picker shows `machine_name · directory`. `machine_name` is always
  `os.hostname()` and takes no flag, and `directory` is the cwd, fixed at
  `/workspace` because claude trusts only that path. So `--hostname` on the
  emitted `docker run` is the single lever, and it moves the session-name
  prefix too, because that prefix is
  `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX || os.hostname()`. A later
  workspace rename never reaches the box: the boot script renders once, at
  create.

- 2026-08-25: canary worker `dee622d7` at main `10d1ab9` (PR #48). Worker-only,
  no migrations ("No migrations to apply"), no image rebuild — nothing under
  `packages/box` or `packages/broker` changed, so the `canary-4611cc4` pin
  stands. Shipped: a template can now name any PUBLIC GitHub repo by URL, not
  only what the org GitHub App installation reaches. New route
  `POST /connections/github/repositories/check` probes
  `github.com/<owner>/<name>.git/info/refs?service=git-upload-pack` — the exact
  first request `git clone` makes — so a 200 proves the credential-free clone
  the bootstrap runs. `api.github.com` was rejected: 60 anonymous requests per
  hour per source IP, and Worker egress is shared. GitHub answers 401 for both
  private and missing repos, so the verdict is named `not-public`. Verified
  live: route 401s (auth-gated, present) where an unknown sibling 404s, and the
  bundle carries `repositories/check`, `Attached`, and each problem message.
  Deployed from a scratch worktree with the canary toml copied in, which sizes
  the `.env` auth-hijack gotcha above out of the picture: a worktree has no
  `.env`, so wrangler uses the OAuth login and `npm run` is safe there.
  Deploy-gate note: this PR went red on CI after a green local `npm test`.
  `CORE_MANIFEST` is hand-written in three files with two length assertions;
  only `test/core-imports.test.ts` runs ungated. Run
  `BLITZDEV_MANAGED=1 npm test` before pushing a new `core/` file.

## Promoting canary to client prod

Read this before you try to deploy production. It answers the three questions
that stop people.

### You do NOT need production credentials. Ever.

Nobody deploys client prod by hand, and no workspace, box, or agent should hold
a credential that reaches the `blitzapp` account (`d25a778b…`). If your token
answers `9109` or `10000` for that account, that is correct, not a fault.

The only supported path is a `v*` git tag. `.github/workflows/release.yml`
holds the credentials as repository secrets and does the whole job.

### What the tag does, in order

1. Builds and pushes the box and broker images for amd64 and arm64, tagged with
   the tag name and `latest`.
2. Writes `PROD_WRANGLER_TOML` over `packages/control-plane/wrangler.toml`.
3. Pins the box digest it just built, with `set-box-image-ref.mjs`.
4. Refuses to continue if that image is not publicly pullable. A private image
   would break every new workspace, so the job stops and prod keeps its old
   image.
5. Runs `npm run deploy -w packages/control-plane`, which applies D1 migrations
   and deploys the Worker.

So the image and the Worker always ship together, in the right order. That is
the answer to "the published box image is older than the control plane". Do
not deploy the control plane alone, and do not publish an image by hand for a
production release.

### Before you cut the tag

- Canary must run the SAME commit you are about to tag. Check the bundle hash,
  not the branch name.
- Read the Deploy section of every PR in the range. Any that says "new
  workspaces only" reaches prod only through the image this tag builds.
- List the migrations the tag will apply. Rolling the Worker back past a
  column-dropping migration breaks the old code's writes.
- There is no traffic ramp and no rollback script. A deploy goes to full
  traffic at once. Rollback means redeploying the previous version, and
  re-pinning the previous digest.

## Rules for agents working on deploys

1. **Never deploy a branch to canary.** Canary is one shared Worker and the
   last deploy wins. Deploying a branch silently replaces whatever main-based
   build was there, and the next person debugs a build that does not match any
   commit. Land the PR, then deploy main.
2. **Identify a deployment by its bundle hash — but know what that hash
   covers.** Fetch `/` and read the `/assets/index-*.js` name. Vite hashes are
   deterministic for the same source, so the name identifies the WEBAPP build
   exactly. It says nothing about worker-only code. A change to
   `core/bootstrap.ts`, a route, or a provider leaves the hash identical.
   Measured 2026-08-25: deploying main over a feature-branch build produced the
   same bundle name, because the branch's webapp work had already merged and
   the missing commit was worker-side. For worker-only changes, trust the
   commit you deployed from and check behaviour, not the hash.
3. **Check whether the box image needs rebuilding.** Run
   `git diff --stat <deployed-sha>..HEAD -- packages/box packages/broker`. If
   it is empty, the existing pin still stands and a worker deploy is enough.
4. **Deploy from a clean worktree at `origin/main`.** The main checkout often
   sits on a feature branch with unpushed work. Deploying from it ships that
   branch. Copy the gitignored `wrangler.toml` into the worktree first.
5. **Verify the deploy, do not assume it.** Fetch the live bundle and grep for
   a string the change introduced. A green deploy command proves upload, not
   content.
6. **Stop at production.** An agent may deploy canary. Cutting a `v*` tag is a
   human decision, because it reaches a real client.
