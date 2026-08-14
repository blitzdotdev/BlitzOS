# Gaps to the 100-eng ICP, with solutions

Target buyer: platform teams at ~100–500-eng companies (Duolingo/Zocdoc/Faire tier). Not DoorDash-class builders. Source: 2026-08-12 GTM research + this week's e2e state + v2 identity scan.

## A. Distribution — the locked front door (first, mostly owner keys)

Gap: ghcr images private; `teenybase@0.0.15` unpublished; platform PR #11 unmerged. A stranger cannot install anything today.
Solution: merge + deploy PR #11; publish teenybase to npm; tag a release so CI pushes public multi-arch images; then the one-pass mode-(b) finish (fresh probe, commit, managed cockpit). All the code exists.

## B. Agent IAM — the moat, zero code today (the sale)

Gap: no scoped tokens, no issuance log, site-claims-audit contradiction (broker TODO deletes the event log). Broker mints consumer OAuth only — a ToS smell for this ICP.
Solution, GitHub-App shape (v2 already contains the hard part):
1. **Token service in the control plane**: `POST /workspaces/:id/tokens` mints short-lived, scoped, per-task tokens. First integration: GitHub App — port v2's flow single-tenant (`github_installations` tables; 9-minute RS256 App JWT; narrowed installation access tokens). AWS STS shape second.
2. **Injection**: deliver into the workspace over the existing box-token channel; extend `blitz-cred token <integration>` to call the CP. No long-lived credentials on disk, ever.
3. **Append-only issuance log**: who/task/scope/TTL per mint; cockpit view. Reverses the broker event-log deletion. This is the CloudTrail claim made true.
4. **Manifest v0** in `packages/schema`: per-workspace declared scopes = the mint ceiling. Spec-grade doc; CP enforces mint ≤ manifest.
5. Invariants (load-bearing): identity-per-task upstream; short TTL + re-mint as kill switch; approvals stay at the ACP layer.
Broker repositions as the optional high-assurance backend ("credential never touches the box") — the Drata angle.

## C. Identity — single-tenant subset of v2 (foundation for B's attribution)

Gap: one `operator` principal; no users, no SSO, no API keys.
Solution — copy v2, drop orgs (per scan, file:line in the scan report):
- Tables: `users` (from `identities`; GitHub OAuth id/login), role+status on user (from `memberships`, keep `admin/member`), `api_keys` (`blitz_*` opaque, SHA-256 hash stored), `invites`, `workspaces.owner_user_id`.
- Auth: GitHub OAuth + PKCE sign-in (this IS the SSO answer for 100-eng orgs); stateless HMAC-signed `blitz_session` cookie (v2 `auth.ts` shape) — replaces the D1 session table; `/api` accepts session or bearer key, no fallback.
- Authorization: `admin || owner_user_id === user.id`. Operator key demotes to a bootstrap secret that seeds the first admin.

## D. Entrypoints — zero today (the Flux "invocation surfaces" lesson)

Gap: no machine path to the actor (loopback + origin-allowlist-that-allows-missing-Origin is not auth); no task runner; no Slack/Discord.
Solution, dependency order:
1. Actor bearer auth (small; prerequisite to any exposure).
2. Task-runner primitive: ensure-workspace → ACP session → prompt → stream → complete, as CP route + small SDK, through the journal (trust = visibility, runs show in the cockpit).
3. Slack connector first: signing-secret verify, 3 s ack + async continue, thread↔session mapping, in-thread approvals from ACP permission events. Discord second. Connector stays plain-Node portable.

## E. Substrate fit for the ICP

Gaps: Hetzner-first (ICP lives on AWS/GCP); microVM pool is one host behind an ephemeral tunnel; workspaces start empty (Flux pre-provisions repos/tools/secrets).
Solutions: AWS `VmProvider` adapter next (the seam is proven — microVM landed without touching the API); durable tunnel (named CF tunnel or tailscale) for the agent; **workspace templates**: manifest declares repo + integration → bootstrap clones via a B-minted token at create time — this composes IAM + identity + substrate into the demo that sells; multi-host scheduler when a partner needs it (hosts table already designed in MICROVM.md).

## F. Trust surface

Gaps: no threat model, no SECURITY.md; Hetzner path still `--privileged` DinD; audit claim contradiction (fixed by B).
Solutions: threat-model doc (cheapest high-scrutiny win); lead with the microVM path — hardware isolation without `--privileged` is a differentiator; SECURITY.md + signed images ride the existing release workflow.

## G. BYOC portability (locked constraint from research)

Gap: CF-shaped runtime (Workers, D1, teenybase-CF).
Solution: the ports-and-adapters `core/` already isolates all logic behind `Db`/blob seams — add a plain Node + libSQL third shell when the first BYOC design partner appears. Genuinely small now; do not build ahead of the partner.

## Order

A (owner keys) → C identity → B token service + log + manifest → D runner + Slack → E AWS adapter + templates → F docs alongside → G on demand.
The demo that sells, end-state: "Slack thread → workspace in 1.4 s with your repo cloned via a scoped 9-minute token → every action in the journal → every mint in the log."
