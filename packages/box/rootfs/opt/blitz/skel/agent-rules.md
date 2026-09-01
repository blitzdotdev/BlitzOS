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
You ask for a token at the moment you need it, and the platform checks this
workspace's allow-list on every ask.

Three commands, and no others:

```
blitz-cred list              # providers this workspace may use, one per line
blitz-cred get <provider>    # print that provider's token, and nothing else
blitz-cred env <provider>    # print eval-able NAME=VALUE lines for that provider
```

Scope the secret to the one command that needs it:

```
GH_TOKEN=$(blitz-cred get github) gh pr list
```

The variable dies with that command. Use `blitz-cred env` when a tool wants
several names, or when you need the API base URL as well. Keep it inside a
subshell so it dies there too:

```
( eval "$(blitz-cred env linear)"
  curl -sS -H "Authorization: Bearer $LINEAR_API_KEY" "$LINEAR_API_URL/graphql" )
```

`blitz-cred env` prints one comment line naming the header to send, because the
shape is not the same everywhere: Discord wants `Bot `, and some providers want
a bare `Authorization` value. Read that line rather than guessing.

`curl`, `gh`, and `python3` are installed. Use them directly.

## When a connection is not authorized

`blitz-cred get` refuses when this workspace is not connected to the provider,
or when nobody has supplied a credential for it. The refusal names the reason
and files a request in the user's connections panel. Then run:

```
blitz connections open <provider>
```

This opens the workspace connections panel for the user with that provider
highlighted. Tell the user you opened it and ask them to connect the provider.
Do not keep retrying: the provider stays refused until they connect it.

Once the user says they connected it, run `blitz-cred get <provider>` again. It
works immediately. There is nothing to sync and no session to restart.

### Do not use `/mcp` here

Workspace sessions have no MCP servers and no claude.ai connectors. Ask for a
token with `blitz-cred`, nothing else. `/mcp` and a "connector" both answer for
a different product surface — reaching for them here only costs a turn.

## Sharing secrets with the workspace

A workspace credential is a named secret every member machine can pull.
`blitz-cred list` shows workspace credentials next to providers; `get` and
`env` serve them the same way.

To move the keys in a dotenv file into the workspace store:

```
blitz-cred import .env             # store each KEY=value line
blitz-cred import --check .env     # parse and report, store nothing
```

Each key becomes one credential, labeled with the file it came from.
Importing an existing name rotates it: the old value is gone on the next
pull. Only a workspace admin's machine can import. A value must be one
line; base64-encode a PEM or JSON key first.

Import exists to get secrets OUT of files. After a successful import,
delete the file and pull keys at the moment of use:

```
( eval "$(blitz-cred env STRIPE_API_KEY)"; use it here )
```

A credential can carry a comment: one line that says what the key is for.
`blitz-cred list` prints it after a `#` — read the comments before you
pick a key. To store an important key WITH its comment, send the value on
stdin:

```
printf '%s' "$VALUE" | blitz-cred put STRIPE_API_KEY --comment "test-mode key, safe for CI"
```

Import never reads or writes comments, and a rotation keeps the comment
the name already has. When you store a key others will use, write the
comment — it is what the next agent reads instead of asking.

## Never print a credential

Never echo, print, log, or paste the value of a credential — not into a
message, not into a file, not into a command you show the user. That includes
every `*_TOKEN`, `*_API_KEY`, and `*_SECRET` variable, and anything
`blitz-cred` hands back. Use the variable by name (`$GH_TOKEN`), never by
value. A transcript is not a private place: a token that appears in one has to
be rotated.

Never write a token into a file, a shell profile, or a `.env`. Ask again
instead — asking is cheap, and a stored token outlives the permission that
granted it.

`blitz-cred list` names the providers this workspace may use, without printing
a single value. Use it instead of dumping the environment.

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
