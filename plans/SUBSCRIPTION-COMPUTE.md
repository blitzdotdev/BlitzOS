# SUBSCRIPTION COMPUTE — a subscribed org runs on platform infrastructure

Written 2026-08-27, grounded against `feat/warm-box-volumes` @ 73bc159. One
migration, one integer, one branch in `resolve()`. Goal: a paying org stops
bringing its own Hetzner key and runs on ours — which is also the only way the
golden image ever reaches a customer.

```
POST /workspaces
       │
       ▼
OrgComputeProviderResolver.resolve(provider, orgId)
       │
       ├─ org has its own credential? ─────────────► ORG project
       │         (always wins; BYOK stays supported)   stock Ubuntu, org pays
       │
       ├─ entitlements.platform_compute = 1? ──────► DEPLOYMENT project
       │         (the new branch)                     GOLDEN SNAPSHOT, we pay
       │                                              45.3 s create
       │
       └─ policy = byok-required ──────────────────► 402 credential required
                                                      (today: every org)
```

## 0. Ground truth

| Fact | Where | Consequence |
|---|---|---|
| The credential policy is one deployment-wide env var, read in two places, with no per-org lookup | `core/compute/org-credentials.ts:293,402,426` | Today a paying org and a free org are indistinguishable to `resolve()` |
| The billing seam writes exactly two integers: `seat_limit` and `orgs.vm_limit`. Core never learns a plan name | `migrations/0031`, `core/entitlements.ts:270-278` | The service *cannot* express "this org may use our key" today |
| `byok-required` refuses with 402 and a route to add a credential | `org-credentials.ts:381-389` | The refusal is already the right shape; it just needs an exemption |
| The golden image is scoped to the deployment credential only, because a Hetzner snapshot lives in one project | `org-credentials.ts:300-312` | It is inert under `byok-required`, and goes live the moment this plan lands |
| Every workspace and volume row pins `compute_credential_source` at create, and destroy plus the janitors resolve by it | `migrations/0032`, `core/workspaces.ts:1082-1092`, `core/janitors.ts:76-83` | A lapse cannot strand resources: each row already remembers whose key made it |

## 1. Load-bearing decisions

**D1 — One integer, not a plan name.** Add `org_entitlements.platform_compute
INTEGER NOT NULL DEFAULT 0`. The billing service translates its plan into 0 or
1 and pushes it through the existing `PUT /orgs/:id/entitlements`. This is the
whole point of the seam as `migrations/0031` describes it, and a plan name in
core would be the first crack in it. A boolean-shaped integer matches
`seat_limit`'s precedent of integers-only.

**D2 — An org credential always wins.** The order stays: org credential, then
platform entitlement, then refuse. A team that adds its own key keeps using it
even while subscribed — predictable, and it preserves the strict source pinning
that already stops a deployment key from touching an org's resources.

**D3 — A lapse never touches a running workspace.** `compute_credential_source`
is pinned per row, so an org that drops to 0 keeps its live workspaces on the
deployment key until it destroys them, and destroy resolves by the pinned
source exactly as it does now. Only *new* creates refuse. The alternative —
sweeping running VMs on downgrade — deletes a customer's work to collect a bill.

**D4 — `orgs.vm_limit` is the cost ceiling, and it already exists.** Once we
pay for the VMs, the cap stops being a fairness knob and becomes the spend
control. It is enforced in the create transaction (`core/workspaces.ts:529-534`, refusal at `:553-557`)
and the billing service already writes it. Nothing new is needed.

**D5 — The golden image needs no change.** It is already deployment-scoped, so
subscribed orgs get the 45.3 s create for free and BYOK orgs keep booting stock
Ubuntu in their own project. That is correct, not a gap: a snapshot id from our
project is meaningless in theirs.

## 2. The change

**Schema** (`0039_platform_compute.sql`):
```sql
ALTER TABLE org_entitlements ADD COLUMN platform_compute INTEGER NOT NULL DEFAULT 0;
```
An absent row still means the free tier, so the default and the missing row
agree — the same reasoning `0031` uses for `seat_limit`.

**Resolver.** `resolve()` gains one lookup between the org-credential branch and
the refusal. It reads `platform_compute` for the org and returns
`this.deployment(provider)` when it is 1. `resolveVolume` needs no change: it
already falls back to the deployment key for lifecycle calls.

**Entitlements writer.** `PUT /orgs/:id/entitlements` accepts
`platformCompute?: boolean` and stores 0/1. `GET /orgs/:id/usage` reports it, so
an admin can see why creates are refused.

**Wire.** `EntitlementsRequest` and the usage response gain the field in both
`core/wire.ts` and `packages/schema/src`; `test/wire-drift.test.ts` pins the
copies. Fixtures under `schema/fixtures/entitlements/` gain a case with the flag
set, because the billing service pins the same corpus.

**Webapp.** ~~The 402 today says "add a credential". For an org whose plan should
include compute it should say so instead.~~ **Amended 2026-08-27 (PR for
`0037`): dropped, the branch is unreachable.** An org with the flag never
receives the 402, and an org without it has no such plan. The one residual case
— flag set, deployment holds no Hetzner token — is a 409, where that wording
would be wrong.

**Provider statuses.** `providerStatuses()` must read the flag too. Missed when
this plan was written: `/machine-types` drops any provider whose access is
`credential-required` (`core/app.ts:109-110`), so a subscribed org would pass
`resolve()` and still be shown an empty catalog — refused one screen earlier,
for a reason that no longer holds.

## 3. Done when

1. A subscribed org with no credential creates a workspace on the deployment
   key, and the row records `compute_credential_source = 'deployment'`.
2. That workspace boots the golden snapshot, and reaches ready in about 45 s.
3. An unsubscribed org still gets the 402, with the route to add a key.
4. An org with its own credential still uses it while subscribed (D2).
5. Setting `platform_compute` to 0 leaves running workspaces alive and
   destroyable, and refuses the next create (D3).
6. `orgs.vm_limit` still refuses the create above the cap (D4).

## 4. Open

- **Client prod needs its own bake.** A snapshot is per-project. `canary.yml`
  pins `hel1=425047509`; `release.yml` gets a line only after a bake in prod's
  Hetzner project, and only if that project is a different one.
- **One location.** Only `hel1` is baked. `cpx21@hil` and `cpx31@hil` are in
  the default catalog and would take the stock path until baked too.
- **Abuse.** Free-tier signup plus a plan flag is a path to our Hetzner bill.
  `vm_limit` bounds the count; nothing bounds the runtime. Out of scope here,
  but it is the next question after this lands.
