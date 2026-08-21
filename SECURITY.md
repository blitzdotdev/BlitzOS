# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub security advisories:
[github.com/blitzdotdev/BlitzOS/security/advisories/new](https://github.com/blitzdotdev/BlitzOS/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). Do not open
a public issue for a security problem. Include what you found, how to
reproduce it, and what an attacker gains. You will get an acknowledgment and
a fix-or-mitigation plan through the advisory thread.

## Deployment posture: signup is open by default

Any Google account that can reach a deployed control plane's URL can sign in,
create its own org, and provision workspaces on the operator's cloud
accounts, up to the per-org VM limit. Gate it with the built-in Worker vars:
`SIGNUP_MODE = "invite"` (new accounts only through invite links) and
`ALLOWED_EMAIL_DOMAINS` (every sign-in must come from a listed domain). For
extra layers, put Cloudflare Access (or an equivalent authenticating proxy)
in front of the Worker, or restrict sign-in at Google's side with an
**Internal** OAuth consent screen (Google Workspace orgs only). See the
[self-host guide](docs/SELF-HOST.md), step 7.

## Secret inventory and blast radius

| Secret | Holder | If it leaks |
|---|---|---|
| `CRED_MASTER_KEY` | Worker | Decrypts every stored integration credential in the database. Rotating it does **not** re-protect data already exfiltrated, and credentials sealed under the old key become undecryptable — re-enter integrations after a rotation. |
| `WEBAPP_TOKEN_SECRET` | Worker | Mints workspace webApp tickets and derives per-workspace guest credentials — terminal, chat, and files access to any workspace. Rotate freely: tickets live 60 seconds; derived guest credentials change with the secret. |
| `CLOUDFLARE_API_TOKEN` | Worker | Scoped to Tunnel Edit + DNS Edit + Zone Read: can create or delete tunnels and DNS records on the account and zone. Keep the scope exactly as documented in [docs/TUNNEL.md](docs/TUNNEL.md). |
| `HETZNER_API_TOKEN` | Worker | Full VM and volume lifecycle in its Hetzner project — create, list, and **delete**. Use a dedicated project holding nothing but BlitzOS workspaces, so the blast radius is the fleet, not your other infrastructure. |
| `GOOGLE_CLIENT_SECRET` | Worker | Enables OAuth token exchange for your client ID; combined with a registered redirect an attacker can phish sign-ins. Rotate in the Google console. |
| `OPERATOR_API_KEY` | Worker | Only gates the one-time database-migration bootstrap URL. On a fresh deployment it authorizes nothing. |
| `MICROVM_*_TOKEN` | Worker + host | Bearer token for a Firecracker host agent: create and destroy microVMs on that host. Rotate by updating the Worker secret and the host's token file together. |

Worker secrets are set with `wrangler secret put`; updating one creates a new
deployment, and running isolates drain.

## Workspace trust model

Treat a workspace as a single trust boundary. Inside it:

- the box container runs `--privileged` with an inner Docker daemon (DinD);
- agent harnesses are launched with permission prompts off
  (`claude --dangerously-skip-permissions --permission-mode bypassPermissions`,
  `codex --dangerously-bypass-approvals-and-sandbox`);
- anyone with terminal or chat access can act with every credential the
  workspace holds.

Isolation is per-VM, not per-process: the boundary is the single-tenant VM
(or your Firecracker guest), never the container. Scope what you put into a
workspace accordingly — a shared workspace is full-trust for all its members.

## Provisioning invariants

- **Never put secrets in VM `user_data`.** It is readable from inside the VM
  for the VM's whole life. The bootstrap instead uses a single-use phone-home
  capability URL, minted per provision and dead after one use; the box
  credential arrives in the phone-home response and is written `0600` on the
  state volume.
- Box images and their R2 archive routes are public by design; never bake a
  secret into the image.

## What never gets committed

- `packages/control-plane/wrangler.toml` — your copy carries your account and
  database IDs; only the `.example` template belongs in git.
- `.env`, `.dev.vars`, or any file holding a token.
- Scratch or session directories (`scratchpad/` and similar) — they routinely
  hold private keys and live URLs from working sessions.
