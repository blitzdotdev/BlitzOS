# blitz.dev platform asks

Constraints on managed (dynamic) projects that blitz-core needs lifted, instead of working around them. Platform code: `~/superapp/teenybase/backend` (+ `project-gateway`). Discovered during the blitz-core control-plane port; the port agent appends entries with exact file:line pointers and proposed lifts.

Format: constraint → where it is enforced → proposed lift → what blitz-core does until then.

## 1. No cron / scheduled events for managed projects
- Enforced: limitation list in `backend/src/routes/agent-briefing.ts` (~:230); loader only dispatches HTTP fetch (`project-gateway/src/index.ts`).
- Lift: allow projects to declare schedules (e.g. in `teenybase.ts`); gateway invokes the worker's `scheduled()` (or a designated route) on the platform's own cron.
- Until then: blitz-core runs a rate-limited lazy sweep on API traffic (kept afterward as defense in depth).

## 2. No static asset serving for managed projects
- Enforced: source-files-only bundle contract (1 MB/file) in the build pipeline (`backend/src/build/pipeline.ts`); no assets mechanism in the loader environment.
- Lift: first-class assets — an upload channel that lands files in the project R2 under an assets prefix plus default serving (or an `[assets]`-equivalent in the loader env).
- Until then: blitz-core stores cockpit files via file fields in the project R2 and streams them through its own asset route (`$db.getFileObject()`), which is the interim shape of this exact feature.

## 3. No raw/large R2 object API (640 MB box-image archive)
- Enforced: R2 reachable only through file fields / `$Database` RPC adapter; no documented large-object or multipart upload path; briefing documents only the 1 MB source-file limit.
- Lift: sanctioned large-object upload (multipart or presigned) into the project bucket + streaming reads.
- Until then: box-image parts are attempted through file fields; fallback is an external `BOX_IMAGE_REF` (public ghcr).

## 4. Project teenybase version is recorded but build/runtime resolve `latest`
- Enforced: file-save builds fetch `teenybase:latest` (`backend/src/routes/project-files.ts:112-124`), and commit does the same (`backend/src/routes/projects.ts:601-618`). The gateway eagerly fetches the latest bundle (`project-gateway/src/index.ts:165-172`) and prefers it when loading project code (`project-gateway/src/index.ts:247-255`), even though each project entry records `tb_version` (`backend/src/utils/project-helpers.ts:369-390`).
- Lift: resolve and cache `teenybase:<project.tb_version>` consistently in source validation, commit, snapshots, and gateway execution; expose an explicit, reviewed project-version upgrade operation instead of silently advancing existing projects.
- Until then: blitz-core may build and commit only to the disposable probe project for validation; Target B production promotion waits for the lift. Observed version reporting and post-commit smoke tests remain useful evidence but are not treated as a pin, and this is not permission to vendor or patch around teenybase.

## 5. Managed R2 RPC accepts one delete key while teenybase can issue a key array
- Enforced: the backend's managed bundle includes the teenybase Worker runtime (`backend/src/build/bundle-entry.ts:6-8`), and the gateway supplies its project R2 RPC adapter (`project-gateway/src/index.ts:286-291`). `$Database` accepts `string | string[]` in its delete helper and passes arrays when removing file fields (`src/worker/$Database.ts:903-918,1033-1041`), but `R2RestRPC.delete` and `R2RestAdapter.delete` accept only one string (`src/worker/storage/R2RestRPC.ts:54-56`; `src/worker/storage/R2RestAdapter.ts:108-114`).
- Lift: support `string | string[]` end-to-end in the managed R2 RPC protocol and adapter, preserving batch semantics, and add integration coverage for editing/deleting rows containing one and multiple file fields.
- Until then: blitz-core uses immutable file generations with `autoDeleteR2Files: false` and performs no managed file GC. Old cockpit and box-image objects remain retained until the platform path is fixed and an audited cleanup operation is available.

## 6. Agent tokens cannot read managed-preview runtime diagnostics
- Enforced: the gateway writes the underlying worker exception only to its own `console.error` and returns the generic `WORKER_RUNTIME_ERROR` response (`project-gateway/src/index.ts:311-316`); the agent capability list has no logs endpoint (`backend/src/routes/agent-briefing.ts:162-176`) even though the briefing directs runtime failures to dashboard logs that require a human session.
- Lift: add an agent-token-authenticated, read-only endpoint for recent project runtime failures with bounded retention and redaction, including exception class/message, stack locations within project source, limit-exceeded classification, timestamp, and Ray ID.
- Until then: blitz-core records cache-bypassed preview statuses and Ray IDs, reproduces the emitted bundle locally, and treats a generic preview runtime failure as unresolved platform evidence rather than modifying source blindly or treating build success as a liveness pass.

## 7. Managed bundler reports success for a Loader-incomplete relative module graph
- Captured on the disposable blitz-core probe at `teenybase-project-gateway`: `Error: No such module "app.js". imported from "bundle.js"` at the Worker Loader.
- Enforced/defect: blitz-core uploaded `core/app.ts`, and `core/index.ts` imports it through the standard NodeNext runtime specifier `./app.js` (`packages/control-plane/core/index.ts:1`). `@cloudflare/worker-bundler` 0.1.3, selected by `backend/package.json:23`, resolves extensionless imports but does not substitute an explicit `.js` specifier to the corresponding `.ts` source; after missing `core/app.js`, its virtual-filesystem resolver silently marks `./app.js` external. Bundled mode still returns `mainModule: "bundle.js"` and only `modules["bundle.js"]`, so `backend/src/build/pipeline.ts:140-172,243-271` reports `bundle.ok: true` and save/commit persist a bundle that imports a module they did not emit. The gateway faithfully spreads those project modules and adds only `teenybase` plus `virtual:teenybase` (`project-gateway/src/index.ts:267-293`), leaving `app.js` absent.
- Lift: fix worker-bundler relative resolution to map NodeNext runtime specifiers (`.js` → `.ts`/`.tsx`, `.mjs` → `.mts`, `.cjs` → `.cts`) when the exact file is absent, and make every unresolved relative import a build error instead of an external; publish and exactly pin the fixed bundler. Add a backend post-bundle module-closure check plus a workerd regression proving `worker.ts` → `./core/index` → `./app.js` loads when `core/app.ts` is present and returns `bundle.ok: false` when it is absent. As immediate platform-local containment, `backend/src/build/pipeline.ts:163-169` can pass a first-running resolver plugin that performs the substitutions and rejects unresolved relative paths.
- Contract/until then: managed projects require only `teenybase.ts/js` and `worker.ts/js`, and the briefing says these are the only required files and that relative imports are bundled automatically (`backend/src/routes/agent-briefing.ts:178-214`); the empty starter likewise contains only `teenybase.ts`, `worker.ts`, and `package.json` (`backend/src/templates/blitz/empty.ts:222-231`). `app.js` is neither a required project entry nor a module imported by the platform framework bundle entry. With `bundle: true`, `core/app.ts` must be absorbed into `bundle.js`, not duplicated as a synthetic `app.js`. Until the fix, Target B remains blocked; blitz-core retains its 23-source-file manifest and retries the disposable probe only after `bundle.ok` means Loader-loadable.
