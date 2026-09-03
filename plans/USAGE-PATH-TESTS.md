# Usage-path tests: an explorer writes the test once, CI runs it forever

Status: **design draft, 2026-09-03.** Nothing here is built. The draft records
the minimum shape of a test that exercises a human critical path against real
dependencies, authored once by an agent and run afterwards with no agent
present. It is deliberately not a workflow engine.

## 0. The gap this closes

The three gates, the Go suites and the box-image smoke test prove that the
code is coherent and that a box boots. None of them sees a real control plane,
a real VM, a real vendor login or a real Lody turn. The live scripts under
`tools/e2e/` do, but each one was written by hand for one incident, takes a
person to run, and is silently stale the next time the surface it drives
changes (`tools/e2e/credentials.mjs` still calls a `blitz-cred token` verb the
binary no longer has).

The broker retirement (plans/BROKER-RETIREMENT.md) was verified by an agent
that brought environments up, poked them, wrote checks and tore them down.
That work was thrown away when the session ended. The point of this plan is
that the second time a path needs verifying, nobody has to do that again.

## 1. Locked shape

One artifact, one loop, one authoring rule.

1. **A job is a directory in the repo.** A manifest and an entry script. The
   script drives the product the way a person does and asserts at the surface
   a person sees. It is an ordinary test after it is admitted.
2. **The runtime is a sandbox with a lease and an allowlist.** Allocate,
   mint, fence, run, collect, revoke, destroy. Nothing survives a job except
   its artifacts.
3. **An explorer agent writes each job once**, in the same sandbox, lease and
   allowlist the job will run in, and the job is admitted only after it passes
   once more with no agent present.

There is no DAG, no durable execution, no step debugger, no trace recorder
and no undo. Each of those was considered and cut; §6 says why.

## 2. The job

```
jobs/<feature>/<path>/
  job.toml
  run            # the entry script; any language the image carries
  artifacts/     # written by the run; collected by the runtime
```

`job.toml` declares five things and nothing else:

```toml
# The human path, in one sentence. The explorer worked from it; a reader
# checks the assertions against it.
path = "A member signs in, creates a workspace, and reaches a terminal tab."

[sandbox]
image = "blitz-box"           # what the run executes inside
size = "small"                # driver-specific

[secrets]
# Names only. The runtime mints a lease per name for this job id.
names = ["GH_PAT", "ANTHROPIC_OAUTH"]

[network]
# Egress the path genuinely needs. Everything else is refused.
allow = ["cp.example", "api.anthropic.com", "github.com"]

[budget]
wall = "20m"                  # also the lease TTL
retries = 1
money = "0.10 EUR"            # for jobs that create cloud resources
```

The entry script exits 0 or non-zero and may print lines the runtime
classifies:

- `TRANSIENT: <reason>` — retry within the budget.
- `ENVIRONMENTAL: <reason>` — a missing tool, token or quota. Escalates to a
  person; it is never a product finding.
- anything else non-zero — a real failure of the path.

The script asserts what the person would see: HTTP status and body, terminal
output, files on disk, browser state through a headless browser when the path
has a UI. Assertions against internal state are allowed only as a second line
of evidence, never as the verdict.

## 3. The loop

```
allocate  a fresh sandbox from the image, labelled with the job id and a TTL
mint      one short-lived credential per named secret, scoped to the job id,
          expiring at the budget; the sandbox receives the lease, never the root
fence     apply the allowlist; direct egress is refused
run       check out the SHA under test inside the sandbox; execute `run`
collect   copy artifacts out
revoke    the lease, whether the run passed or not
destroy   the sandbox
```

An independent reaper destroys any sandbox and revokes any lease whose TTL
passed, so a dead runner cannot leave a bill or a live credential. That is
the whole runtime. It runs as one CI step per job, jobs in parallel. Debugging
is rerunning the job, or opening a shell in a sandbox with the same lease and
allowlist.

The allowlist is the leak guard as much as the dependency list: a leased
token can only travel to hosts the job declared, so an explorer with a real
credential cannot post it anywhere the path does not go. The simplest portable
fence is an egress proxy the sandbox must use, with direct egress blocked at
the network namespace.

## 4. The explorer

Once per feature, an agent runs in exactly the environment the job will run
in, with the human path as its brief and the acceptance list as its goal. Its
only deliverable is the job directory. It may use real credentials because
the lease bounds how long a leak is useful, the allowlist bounds where it can
go, and the sandbox bounds what it can break. Remove any one of the three and
either real secrets are off the table or an agent cannot be allowed to write
the test. That is why these three are the floor and nothing smaller works.

Admission has one rule: the job passes once more with no agent present before
it merges.

When an admitted job fails later, the runtime classifies by the lines above.
Only a real failure reaches an agent, with the artifacts, the diff since the
last green run and the brief. The agent must answer with one of four verbs:
patch the job and rerun, skip with a written reason, file a product bug, or
abort. Patches are commits, so drift has a history a reviewer can read.

## 5. What this repository already has

- **Sandbox.** The box image is one, Docker included, and the microVM path
  is a faster one. The machine API (`POST /machines/:id/provision`,
  `/stop`, `DELETE`) already allocates and destroys real machines with
  labels, and refuses to destroy what a person made.
- **Lease.** The org-credential plane mints scoped, expiring tokens with an
  audit row and a grant check on every ask. `blitz-cred api-token` is the
  local primitive.
- **Execution environment.** The image carries node, python3, git, gh,
  docker and both vendor CLIs.

Missing:

- a per-job egress allowlist inside the box (an egress proxy plus a default
  deny in the box's network namespace);
- the `jobs/` directory and the manifest above;
- the explorer brief, and the admission replay in CI.

## 6. Deliberately absent

- **No DAG or durable execution.** A job is a script; composition is a
  script calling scripts. A graph runner would be the largest piece of code
  in the system and would test nothing.
- **No trace recorder.** The explorer writes the job on purpose. The
  admission replay is what catches what it forgot.
- **No undo.** Teardown is destroy, revoke, reap. Idempotent steps and
  compensation are what a runner needs when environments are precious; these
  are not.
- **No stepping.** Rerun the job.
- **No evidence diffing.** Artifacts on disk. Add comparison when two runs
  ever need comparing.

## 7. The first jobs

Each of these is a path a person walks today and that no gate covers:

1. sign in, create a workspace, reach a terminal tab through the tunnel;
2. run one Lody turn with Claude signed in natively, and one with Codex;
3. push to GitHub through the box's git credential helper;
4. enroll a box, rotate its bearer, and call `/agent/*` with the new one;
5. request a box update from the box plane and watch the new image land;
6. boot the previous image on a state volume, then this image on the same
   volume, and assert the home was repaired (the broker-era incident).

Jobs 1 through 5 need a control plane that is not canary. A staging Worker
cloned from canary's `wrangler.toml` under a different Worker, D1 and R2 name
is enough; the canary workflow only forbids a branch reaching the shared
canary Worker. Job 6 needs Docker and nothing else.

## 8. Open decisions

- Where the staging Worker lives (same Cloudflare account as canary, or its
  own) and who holds its secrets.
- Whether the egress fence is a proxy in the box or nftables on the host. A
  proxy is portable to every substrate; nftables is invisible to the job.
- The reaper's home: the control plane already sweeps orphaned machines, so
  the job-scoped TTL may be a label it honours rather than a new service.
- Whether explorer runs are allowed against canary at all, or only against
  staging. The lease and allowlist make it safe; the question is blast radius
  on shared data.
