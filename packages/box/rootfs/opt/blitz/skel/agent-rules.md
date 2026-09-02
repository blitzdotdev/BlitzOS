# Blitz box — agent rules

These rules are managed by Blitz. This file is overwritten every time the box
restarts, so do not edit it. Put project-specific rules in
`/workspace/CLAUDE.md` instead — that file is yours and survives restarts.

## Showing a running app to the user

When you start a web UI, dev server, or static HTML page for the user, run:

```
blitz teenyapp open <port>
```

This makes the platform **open the app for the user**. It works for any local
app, not only teenyapps. Do it as soon as the server is listening. Never tell
a first-time user to go hunt for a teenyapp tab — open it for them.
(`blitz preview open` is an alias for the same command.)

- `--path <path>` deep-links to a route, e.g. `blitz teenyapp open 3000 --path /dashboard`.
- `--title <name>` names the app, e.g. `blitz teenyapp open 5173 --title "Docs"`.

### How local apps reach the browser

- Listen on a TCP port in the range **1024-65535**. Avoid **7443-7446** and
  **17445**; the box uses those.
- Bind to an IPv4 loopback or wildcard address (**`127.0.0.1`** or **`0.0.0.0`**).
  Do **not** bind IPv6-only (`::1`) — it will not be reached.
- Within a few seconds the port appears in a workspace teenyapp tab. It
  is served to the browser at `/workspaces/<workspace-id>/webapp/7445/preview/<port>/`.
- Do **not** try to fetch that URL yourself from inside the box. The browser
  holds an auth token that the box does not, so the request will fail from here.
  Just start the server and open the app.

## Sharing a public link

To surface a public link you created (for example a `blitz.dev` app you
deployed), use:

```
blitz teenyapp add <url> --title "<name>"
blitz teenyapp list
blitz teenyapp rm <url>
```

An `https` link opens inline in the workspace when its host is on the
deployment's embed allowlist, which defaults to `*.blitz.dev` but is
configurable per deployment. Any other link opens in a new browser tab.

## Using a connected provider

Credentials are **not** in your environment. Nothing is delivered to this box.
You ask for a token at the moment you need it, and the platform checks what
this machine's member may use on every ask.

The box has no credential CLI. You call the control plane over plain HTTP.
One local helper prints a valid bearer; the origin is on disk:

```sh
CP=$(cat /var/lib/blitz/origin)
curl -sS -H "Authorization: Bearer $(blitz-cred api-token)" "$CP/agent/credentials"
```

That lists the names you may ask for — providers and shared keys — and never a
value. The full endpoint list with schemas and arguments is the API itself:

```sh
curl -sS -H "Authorization: Bearer $(blitz-cred api-token)" "$CP/agent/api"
# OpenAPI; always current — read it, then call what it lists
```

Scope a secret to the one command that needs it, and never print one:

```sh
GH_TOKEN=$(curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
  "$CP/agent/credentials/github/token" | jq -r .token) gh pr list
```

The variable dies with that command. The same response carries `env`, one
`{name, value}` per variable the provider's own tooling reads, and `header`,
which names the header to send — the shape is not the same everywhere: Discord
wants `Bot `, and some providers want a bare `Authorization` value. Read those
rather than guessing. When a tool wants several names, or the API base URL as
well, export `env` inside a subshell so it dies there too:

```sh
( eval "$(curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
    "$CP/agent/credentials/linear/token" | jq -r '.env[] | "export \(.name)=\(.value | @sh)"')"
  curl -sS -H "Authorization: Bearer $LINEAR_API_KEY" "$LINEAR_API_URL/graphql" )
```

`curl`, `jq`, `gh`, and `python3` are installed. Use them directly.

## When a connection is not authorized

A token ask answers `404` with a `request_id` when this workspace is not
connected to the provider, when nobody has supplied a credential for it, or
when the credential is not granted here. The body names the reason, and the
refusal files a request in the user's connections panel. Then run:

```
blitz connections open <provider>
```

This opens the workspace connections panel for the user with that provider
highlighted. Tell the user you opened it and ask them to connect the provider.
Do not keep retrying: the provider stays refused until they connect it.

Once the user says they connected it, ask for the token again. It works
immediately. There is nothing to sync and no session to restart.

### Do not use `/mcp` here

Workspace sessions have no MCP servers and no claude.ai connectors. Ask for a
token at `$CP/agent/credentials/<name>/token`, nothing else. `/mcp` and a
"connector" both answer for a different product surface — reaching for them
here only costs a turn.

## Sharing secrets with the organization

An org credential is a named secret stored once for the organization and
served to every machine whose workspace or member holds a grant on it.
`GET /agent/credentials` lists the ones you may read next to the providers
(`scope: "org"`, with the comment, and `writable` when you may rotate it), and
the token route serves them the same way.

To store an important key WITH the comment that explains it:

```sh
jq -n --arg value "$VALUE" --arg comment "test-mode key, safe for CI" \
  '{value: $value, comment: $comment}' \
| curl -sS -X PUT -H "Authorization: Bearer $(blitz-cred api-token)" \
    -H 'Content-Type: application/json' --data @- "$CP/agent/credentials/STRIPE_API_KEY"
```

The name must be an environment variable name. Any member may create one;
rotating an existing name needs write access to it, and a rotation keeps the
comment the name already has unless you send a new one.

To move the keys in a dotenv file into the store, send the file's text:

```sh
jq -Rs '{text: ., dryRun: true}' .env \
| curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
    -H 'Content-Type: application/json' --data @- "$CP/agent/credentials/dotenv"
```

`dryRun: true` parses and reports every line and stores nothing: read the
`results`, then send it again without `dryRun` to store. Each key becomes one
credential. Importing an existing name rotates it: the old value is gone on
the next pull. A line past your user's authority is refused with its reason,
and the rest still go in. A value must be one line; base64-encode a PEM or
JSON key first.

Import exists to get secrets OUT of files. After a successful import, delete
the file and pull keys at the moment of use, the same way as a provider.

A credential can carry a comment: one line that says what the key is for. The
list prints it — read the comments before you pick a key. Import never reads
or writes comments. When you store a key others will use, write the comment —
it is what the next agent reads instead of asking.

## Sharing a credential (grant changes need a human)

You may propose grant changes — sharing a credential with a workspace or an
org member, or revoking a grant — but nothing applies until the user
approves it in a panel that shows your proposal as an editable diff.

    curl -sS -X POST -H "Authorization: Bearer $(blitz-cred api-token)" \
      "$CP/agent/credentials/grant-proposals" \
      --data '{"changes":[...], "reason":"one sentence; the user reads this"}'

Change shapes are in GET /agent/api. A 403 names changes past your user's
own authority — narrow and retry.

Tell the user a proposal is waiting for them, then poll:

    GET /agent/grant-proposals/<id>        # until state leaves "pending"

Continue from the "applied" list, never from what you asked for — the user
can edit or skip any part of your proposal before approving. "denied" and
"expired" mean no grants changed; re-propose only with a narrower ask or a
better reason.

## Never print a credential

Never echo, print, log, or paste the value of a credential — not into a
message, not into a file, not into a command you show the user. That includes
every `*_TOKEN`, `*_API_KEY`, and `*_SECRET` variable, and anything the token
route hands back. Use the variable by name (`$GH_TOKEN`), never by value. A
transcript is not a private place: a token that appears in one has to be
rotated.

Never write a token into a file, a shell profile, or a `.env`. Ask again
instead — asking is cheap, and a stored token outlives the permission that
granted it.

`GET /agent/credentials` names what this machine may use, without printing a
single value. Use it instead of dumping the environment.

## Getting a machine of your own

You can drive machines over the control plane's machine API, using this box's
own credential. It authenticates as the member who owns this box, so you reach
exactly what that person reaches — no more, and no less.

There is no wrapper. Read the credential the way this box already stores it:

```sh
ORIGIN=$(cat /var/lib/blitz/origin)
TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/var/lib/blitz/box-credential.json","utf8")).access_token)')
auth="Authorization: Bearer $TOKEN"
```

Find a workspace and the machine in it:

```sh
curl -sS -H "$auth" "$ORIGIN/workspaces"            # ids, names, phases
curl -sS -H "$auth" "$ORIGIN/workspaces/<id>"       # .members[].machine.id, .ssh
```

Make a keypair, and bring the machine up with your public key on it:

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/qa -C "agent@$(hostname)"
curl -sS -X POST -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"sshPublicKey\":\"$(cat ~/.ssh/qa.pub)\"}" \
  "$ORIGIN/machines/<machineId>/provision"
```

`sshPublicKey` is optional on `provision` and `recreate`, and it is the only
way a key reaches a machine. Leave it out and the machine keeps whatever key
it already had — an absent key never erases one.

Poll until the machine answers, then read where to go from the same document:

```sh
until [ "$(curl -sS -H "$auth" "$ORIGIN/workspaces/<id>" | jq -r .phase)" = ready ]; do
  sleep 5
done
curl -sS -H "$auth" "$ORIGIN/workspaces/<id>" | jq .ssh   # {host, port, user, hostPublicKey}
ssh -i ~/.ssh/qa -p <port> <user>@<host>
```

Put the machine away when you are done — a running VM costs real money:

```sh
curl -sS -X POST   -H "$auth" "$ORIGIN/machines/<machineId>/stop"   # keeps the disk
curl -sS -X DELETE -H "$auth" "$ORIGIN/machines/<machineId>"        # destroys it
```

The whole API is those six routes plus `GET /machine-types`. Workspace create
and delete are NOT included: a person makes workspaces in the UI, and you drive
the machines inside them. Anything else answers 401 to this credential.

Two things to know before you use it:

- **You can only destroy machines you created.** `DELETE /machines/<id>` and
  `POST /machines/<id>/recreate` are refused with 403 on any machine a person
  made in the browser — including the one this box runs on. A machine becomes
  yours when you `provision` it after it has been destroyed, which is the
  point where nothing of theirs is left on it. Start and stop are always
  allowed; they lose nothing.
- **Put a machine away when you are done.** A running VM costs real money, and
  nothing reclaims it for you.

## Installing packages

- There is no `sudo`. Anything that needs root (including `apt`) will not work.
- `npm i -g <pkg>` works; global installs go under `/opt/blitz/npm`.
- `curl`, `gh`, `git`, `node`, and `python3` are installed. `pip` is not:
  bootstrap it yourself if you need it (`python3 -m ensurepip`, say).
