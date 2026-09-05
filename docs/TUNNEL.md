# Workspace tunnels: Cloudflare setup for self-hosters

## Context

Cloud-VM workspaces connect to the browser webApp automatically. At create
time the control plane makes a named Cloudflare Tunnel for the workspace, a
proxied DNS record `ws-<workspace-id>.<your-zone>`, and hands the box a tunnel
token. The box dials out; it opens no inbound port. The webApp talks only to
the control plane, which proxies terminal, files, and previews through the
tunnel and authenticates every hop. Destroying the workspace removes the
tunnel and the DNS record.

This page is step 8 of the [self-host guide](SELF-HOST.md).

## Requirements

- The Cloudflare account that runs your control-plane Worker.
- A domain you own, added as an **active zone on that same account**.
  Cross-account tunnel DNS does not work. Any spare domain is fine; users
  never see these hostnames.
- Access to the domain's registrar to change nameservers.
- `wrangler` authenticated against the account.
- Default account limit: 1,000 tunnels, which caps concurrent cloud-VM
  workspaces. Enterprise can raise it.
- Two Worker secrets: `CLOUDFLARE_API_TOKEN` (created in step 2) and
  `WEBAPP_TOKEN_SECRET` (a random 32-byte string). Step 5 sets both.
  `WEBAPP_TOKEN_SECRET` is required for every webApp surface on every
  provider, tunnel or not.

## Steps

### 1. Add the zone

1. In `dash.cloudflare.com`, select the account, click **Add a domain**.
2. Enter your domain. Pick the **Free** plan. Accept the DNS defaults.
3. Cloudflare shows two nameservers. Set exactly those at your registrar.
4. Wait until the zone Overview shows **Active**.

### 2. Create the API token

1. Go to `dash.cloudflare.com/profile/api-tokens` → **Create Token** →
   **Create Custom Token**.
2. Name it (for example `blitz-connectivity`).
3. Add exactly three permission rows:

   | Scope   | Group                                        | Level |
   | ------- | -------------------------------------------- | ----- |
   | Account | Cloudflare Tunnel (older UI: "Argo Tunnel") | Edit  |
   | Zone    | DNS                                          | Edit  |
   | Zone    | Zone                                         | Read  |

4. **Account Resources**: Include → your account.
5. **Zone Resources**: Include → All zones from an account → your account.
6. Leave IP filtering and TTL empty. Create the token.
7. Copy only the token value from the copy box. It is one unbroken string of
   letters, digits, `_`, `-`. It never contains `=`, spaces, or quotes. Do
   not copy the `curl` example line.

### 3. Find the zone ID

Zone Overview page, right column, **Zone ID**. Or:

```sh
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=<your-domain>"
```

### 4. Configure the control plane

In `packages/control-plane/wrangler.toml`:

```toml
CLOUDFLARE_ACCOUNT_ID = "<your account id>"
CLOUDFLARE_ZONE_ID = "<zone id from step 3>"
WORKSPACE_TUNNEL_ZONE = "<your-domain>"
```

Leaving these three vars empty does not degrade gracefully for cloud VMs: a
cloud-VM workspace still boots and reports `ready`, but every browser
active surface — terminal, files, and previews — routes through this tunnel and
returns `503 workspace has no webapp tunnel` without it.

### 5. Set the secrets

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN --config packages/control-plane/wrangler.toml
# paste the token from step 2

npx wrangler secret put WEBAPP_TOKEN_SECRET --config packages/control-plane/wrangler.toml
```

`WEBAPP_TOKEN_SECRET` is in the deploy gate's required set, so it may already
be set. Its value and what it protects are in
[step 3 of the self-host guide](SELF-HOST.md#3-set-the-secrets).

### 6. Deploy

```sh
npm run deploy -w packages/control-plane
```

The deploy command applies migrations, re-checks the required secrets, builds
the webApp, and deploys.

### 7. Verify

1. Create a cloud-VM workspace in the webApp.
2. A proxied DNS record `ws-<workspace-id>.<your-domain>` appears in the
   zone, and the workspace terminal, files, and preview tabs work with
   no SSH forwards.
3. Destroy the workspace. The DNS record and tunnel disappear.

## Troubleshooting

- `Invalid format for Authorization header` (codes 6003/6111): the stored
  token is not the token value. Re-copy it; check the charset rule in
  step 2.7.
- Zone queries return an empty list: the token was scoped to the wrong
  account, or the zone is not Active yet.
- Workspace creation fails with a tunnel error: confirm the token has
  Account → Cloudflare Tunnel → Edit, on the same account as the zone.
- WebApp endpoints return 503 `workspace has no webApp tunnel`: the workspace was
  created before this feature was configured. Recreate it.
