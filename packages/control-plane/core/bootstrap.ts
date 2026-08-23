import type { AgentProvider } from "./wire.js";

/** A TUI recipe launch adds only the two invocation files; `blitz-term`
 * consumes them, and the box keeps its image-default `BLITZ_AGENT`, so the
 * workspace chat tab is untouched by the recipe. */
export interface TuiRecipeBootstrap {
  harness: AgentProvider;
  model?: string;
  effort?: string;
  prompt: string;
}

/** A chat recipe launch additionally pins the actor's adapter with
 * `-e BLITZ_AGENT` (the pinned model's provider) and emits the prompt
 * sender. */
export interface ChatRecipeBootstrap {
  harness: "chat";
  agentProvider: AgentProvider;
  model?: string;
  effort?: string;
  prompt: string;
}

/** A recipe launch's additions to the boot. Built by core/recipes.ts from a
 * validated recipe row. */
export type RecipeBootstrap = TuiRecipeBootstrap | ChatRecipeBootstrap;

export interface BootstrapOptions {
  boxImageSha256: string;
  boxImageRef: string;
  boxImageTag: string;
  phoneHomeUrl: string;
  sshPublicKey?: string;
  /** Present only on recipe launches; absent leaves the emitted bytes
   * untouched for every ordinary create. */
  recipe?: RecipeBootstrap;
  /** Org-level agent-usage capture: pre-creates the two transcript HOME dirs
   * and bind-mounts them read-only under /workspace/shared/agent-usage/. */
  usageCapture?: boolean;
  /** Template repos ("owner/name") cloned into /workspace/<name> by a
   * detached best-effort retry loop (TEMPLATES-V2). Absent or empty leaves
   * the emitted bytes untouched for every ordinary create. */
  repos?: string[];
}

/** Shell-escapes a value into one single-quoted token. Exported because the
 * recipe-invocation fixture suite pins the emitted embeddings byte-for-byte. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The invocation file a recipe launch writes to
 * /var/lib/blitz/recipe/invocation.env: one shell-sourceable KEY='value' line
 * per set key, HARNESS then MODEL then EFFORT, unset keys omitted, values
 * single-quoted with shellQuote's escaping. Sole reader: the shared bash
 * parser `blitz-recipe-invocation` that `blitz-term` sources (the chat sender
 * gets model/effort interpolated at render time and reads only prompt.txt).
 * Pinned by `packages/schema/fixtures/recipe-invocation/` and its conformance
 * suite. */
export function recipeInvocationEnvFile(recipe: RecipeBootstrap): string {
  const lines = [`HARNESS=${shellQuote(recipe.harness)}`];
  if (recipe.model !== undefined) lines.push(`MODEL=${shellQuote(recipe.model)}`);
  if (recipe.effort !== undefined) lines.push(`EFFORT=${shellQuote(recipe.effort)}`);
  return `${lines.join("\n")}\n`;
}

/** The chat-harness prompt sender. Emitted into the bootstrap as a quoted
 * heredoc and `docker exec`'d in the background as the blitz user; it retries
 * connecting to the actor with the box's own webapp token (the static-token
 * path grants owner, and 127.0.0.1 is an allowed origin), then runs the
 * minimal ACP sequence once: initialize, session/new, the pinned config
 * options, session/prompt — and exits without waiting for the turn. Model,
 * effort, and the provider's bypass permission are control-plane-known, so
 * they are interpolated at render time; the sender reads only prompt.txt from
 * disk. Any error after the handshake is logged to the delivery log and exits
 * nonzero — fail loudly, but never the boot (it runs detached). Plain
 * CommonJS with no template literals so the surrounding TypeScript template
 * stays literal; `ws` is resolved from the actor's vendored node_modules
 * because Node's global WebSocket cannot send the auth header. */
function recipeSenderSource(recipe: ChatRecipeBootstrap): string {
  // JSON.stringify emits valid JS string literals; model and effort are
  // catalog/pattern-validated tokens, so none of them can form the heredoc
  // terminator or a template-literal escape.
  const model = recipe.model === undefined ? "null" : JSON.stringify(recipe.model);
  const effort = recipe.effort === undefined ? "null" : JSON.stringify(recipe.effort);
  const permission = JSON.stringify(
    recipe.agentProvider === "claude" ? "bypassPermissions" : "never",
  );
  return String.raw`'use strict';
const fs = require('node:fs');
const WebSocket = require('/opt/blitz/actor/node_modules/ws');

const RECIPE_DIR = '/var/lib/blitz/recipe';
const TOKEN_PATH = '/var/lib/blitz/webapp-token';
const ACTOR_URL = 'ws://127.0.0.1:7444';
const CONNECT_DEADLINE_MS = Date.now() + 10 * 60 * 1000;
const CONNECT_RETRY_MS = 3000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MODEL = ${model};
const EFFORT = ${effort};
const PERMISSION = ${permission};

function log(line) {
  const stamped = new Date().toISOString() + ' ' + line + '\n';
  try {
    fs.appendFileSync(RECIPE_DIR + '/delivery.log', stamped);
  } catch (ignored) {}
  process.stdout.write(stamped);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function connectOnce(token) {
  return new Promise(function (resolve, reject) {
    const socket = new WebSocket(ACTOR_URL, {
      headers: { 'x-blitz-webapp-token': token },
      origin: 'http://127.0.0.1',
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    });
    socket.once('open', function () { resolve(socket); });
    socket.once('error', reject);
    socket.once('unexpected-response', function (request, response) {
      reject(new Error('actor refused the handshake with status ' + response.statusCode));
    });
  });
}

async function connectUntilDeadline() {
  while (Date.now() < CONNECT_DEADLINE_MS) {
    try {
      const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      if (token === '') throw new Error('webapp token is empty');
      return await connectOnce(token);
    } catch (error) {
      log('connect attempt failed: ' + describe(error));
    }
    await sleep(Math.max(0, Math.min(CONNECT_RETRY_MS, CONNECT_DEADLINE_MS - Date.now())));
  }
  throw new Error('gave up connecting to the actor: deadline passed');
}

let nextId = 0;

function request(socket, method, params) {
  nextId += 1;
  const id = nextId;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      settle(new Error(method + ' timed out after ' + REQUEST_TIMEOUT_MS + ' ms'), undefined);
    }, REQUEST_TIMEOUT_MS);
    function settle(error, result) {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('close', onClose);
      if (error === null) resolve(result);
      else reject(error);
    }
    function onMessage(data) {
      let frame = null;
      try {
        frame = JSON.parse(String(data));
      } catch (ignored) {
        return;
      }
      // Responses only: inbound requests and notifications carry a method
      // and are left alone (permissions are pre-bypassed, so nothing the
      // actor asks needs an answer from this client).
      if (frame === null || typeof frame !== 'object' || typeof frame.method === 'string') return;
      if (frame.id !== id) return;
      if ('error' in frame) settle(new Error(method + ' failed: ' + JSON.stringify(frame.error)), undefined);
      else settle(null, frame.result);
    }
    function onClose() {
      settle(new Error('socket closed before ' + method + ' answered'), undefined);
    }
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }));
  });
}

async function main() {
  let prompt = null;
  try {
    prompt = fs.readFileSync(RECIPE_DIR + '/prompt.txt', 'utf8');
  } catch (error) {
    log('recipe prompt is unreadable: ' + describe(error));
    process.exit(1);
  }
  const socket = await connectUntilDeadline();
  await request(socket, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'blitz-recipe-sender', version: '0.1.0' },
  });
  const created = await request(socket, 'session/new', { cwd: '/workspace', mcpServers: [] });
  if (created === null || typeof created !== 'object' || typeof created.sessionId !== 'string') {
    throw new Error('session/new returned no sessionId');
  }
  const sessionId = created.sessionId;
  if (MODEL !== null) {
    await request(socket, 'session/set_config_option', { sessionId: sessionId, configId: 'model', value: MODEL });
  }
  if (EFFORT !== null) {
    await request(socket, 'session/set_config_option', { sessionId: sessionId, configId: 'effort', value: EFFORT });
  }
  await request(socket, 'session/set_config_option', { sessionId: sessionId, configId: 'permission', value: PERMISSION });
  nextId += 1;
  // ws runs the send callback once the frame is written out; the turn itself
  // runs in the actor without us, so exit as soon as the frame has left.
  await new Promise(function (resolve, reject) {
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: nextId,
      method: 'session/prompt',
      params: { sessionId: sessionId, prompt: [{ type: 'text', text: prompt }] },
    }), function (error) {
      if (error) reject(error);
      else resolve(undefined);
    });
  });
  log('prompt submitted to session ' + sessionId);
  process.exit(0);
}

main().catch(function (error) {
  log('recipe delivery failed: ' + describe(error));
  process.exit(1);
});`;
}

/** Emits the first-boot script a VM runs: bash, with Python inline for the
 * box-image manifest. It is a template literal rather than a file because a
 * Worker has no filesystem to read at runtime, so the script has to be part
 * of the bundle. The emitted bytes are a contract pinned by
 * `test/bootstrap-python.test.mjs` and the phone-home fixtures — edit them
 * the way you would edit a wire format, not a script. Recipe launches add
 * segments pinned by `test/recipe-invocation-fixtures.test.ts`; a create
 * without a recipe or usage capture emits byte-identical output. Every create
 * additionally emits the `term-3` remote-control session exec (pinned by the
 * same suite). */
export function buildBootstrapScript(options: BootstrapOptions): string {
  const controlPlaneOrigin = new URL(options.phoneHomeUrl).origin;
  const isTarball = options.boxImageRef.startsWith("https://");
  const trimmedSshPublicKey = options.sshPublicKey?.trim();
  const sshPublicKey = trimmedSshPublicKey === "" ? undefined : trimmedSshPublicKey;
  if (isTarball && options.boxImageTag.trim() === "") {
    throw new Error("BOX_IMAGE_TAG is required when BOX_IMAGE_REF is an HTTPS URL");
  }
  if (isTarball && !/^[a-fA-F0-9]{64}$/u.test(options.boxImageSha256)) {
    throw new Error(
      "BOX_IMAGE_SHA256 must be a 64-character hexadecimal digest when BOX_IMAGE_REF is an HTTPS URL",
    );
  }

  const imageSetup = isTarball
    ? String.raw`download() {
  curl --fail --location --retry 10 --retry-all-errors --retry-delay 3 \
    --silent --show-error --output "$2" "$1"
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local actual
  actual=$(sha256sum "$path" | cut -d ' ' -f 1)
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $path"
}

if ! docker image inspect "$BOX_IMAGE_TAG" >/dev/null 2>&1; then
image_tmp_dir=$(mktemp -d /var/lib/blitz/.bootstrap-image.XXXXXX)
trap 'rm -rf "$image_tmp_dir"' EXIT
image_archive="$image_tmp_dir/image.tar.gz"

case "$BOX_IMAGE_REF" in
  */manifest.json)
    manifest_path="$image_tmp_dir/manifest.json"
    manifest_parts_path="$image_tmp_dir/parts.tsv"
    manifest_metadata_path="$image_tmp_dir/metadata.tsv"
    download "$BOX_IMAGE_REF" "$manifest_path"
    python3 - "$manifest_path" "$manifest_parts_path" >"$manifest_metadata_path" <<'PYTHON'
import json
import re
import sys

manifest_path, parts_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as manifest_file:
    value = json.load(manifest_file)

parts = value.get("parts")
total_sha256 = value.get("totalSha256")
image_tag = value.get("imageTag")
if not isinstance(parts, list) or not parts:
    raise ValueError("manifest parts must be a non-empty list")
if not isinstance(total_sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", total_sha256) is None:
    raise ValueError("manifest totalSha256 must be a SHA-256 digest")
if not isinstance(image_tag, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image_tag) is None:
    raise ValueError("manifest imageTag is invalid")

with open(parts_path, "w", encoding="utf-8") as parts_file:
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("manifest part must be an object")
        name = part.get("name")
        sha256 = part.get("sha256")
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) is None:
            raise ValueError("manifest part name is invalid")
        if not isinstance(sha256, str) or re.fullmatch(r"[a-fA-F0-9]{64}", sha256) is None:
            raise ValueError("manifest part sha256 must be a SHA-256 digest")
        parts_file.write(f"{name}\t{sha256.lower()}\n")

print(f"{total_sha256.lower()}\t{image_tag}")
PYTHON
    IFS=$'\t' read -r manifest_total_sha256 manifest_image_tag <"$manifest_metadata_path"
    [ "$manifest_image_tag" = "$BOX_IMAGE_TAG" ] || fail "manifest imageTag does not match BOX_IMAGE_TAG"
    manifest_base=${"${BOX_IMAGE_REF%/*}"}
    : >"$image_archive"
    while IFS=$'\t' read -r part_name part_sha256; do
      part_path="$image_tmp_dir/$part_name"
      download "$manifest_base/$part_name" "$part_path"
      verify_sha256 "$part_path" "$part_sha256"
      cat "$part_path" >>"$image_archive"
      rm -f "$part_path"
    done <"$manifest_parts_path"
    verify_sha256 "$image_archive" "$manifest_total_sha256"
    ;;
  *)
    download "$BOX_IMAGE_REF" "$image_archive"
    ;;
esac

verify_sha256 "$image_archive" "$BOX_IMAGE_SHA256"
gunzip -c "$image_archive" | docker load
rm -rf "$image_tmp_dir"
trap - EXIT
fi
docker image inspect "$BOX_IMAGE_TAG" >/dev/null
box_image="$BOX_IMAGE_TAG"`
    : String.raw`if ! docker image inspect "$BOX_IMAGE_REF" >/dev/null 2>&1; then
  pull_attempt=1
  until docker pull "$BOX_IMAGE_REF"; do
    if (( pull_attempt >= 10 )); then
      fail "docker pull failed after $pull_attempt attempts: $BOX_IMAGE_REF"
    fi
    sleep $((pull_attempt * 3))
    pull_attempt=$((pull_attempt + 1))
  done
fi
docker image inspect "$BOX_IMAGE_REF" >/dev/null
box_image="$BOX_IMAGE_REF"`;

  // Recipe and usage-capture segments; every one is "" on an ordinary create
  // so the emitted bytes stay identical for the non-recipe path.
  const recipe = options.recipe;
  const invocationFiles = recipe === undefined
    ? ""
    : `install -d -o 1000 -g 1000 -m 0700 /var/lib/blitz/recipe
printf '%s' ${shellQuote(recipe.prompt)} >/var/lib/blitz/recipe/prompt.txt
printf '%s' ${shellQuote(recipeInvocationEnvFile(recipe))} >/var/lib/blitz/recipe/invocation.env
chown 1000:1000 /var/lib/blitz/recipe/prompt.txt /var/lib/blitz/recipe/invocation.env
chmod 0600 /var/lib/blitz/recipe/prompt.txt /var/lib/blitz/recipe/invocation.env
`;
  // Only chat pins the actor's adapter; TUI recipes leave the image-default
  // BLITZ_AGENT alone so the workspace chat tab keeps it.
  const agentFlag = recipe?.harness !== "chat"
    ? ""
    : `  -e BLITZ_AGENT=${shellQuote(recipe.agentProvider)} \\\n`;
  // The two transcript HOME dirs pre-exist owned by the blitz user so the
  // read-only mounts never make docker invent root-owned sources, and
  // /workspace/shared/agent-usage pre-exists for the same reason on the
  // destination side (docker would otherwise create shared/ as root and
  // break Drive folder materialization).
  const usageDirectories = options.usageCapture !== true
    ? ""
    : `install -d -o 1000 -g 1000 /var/lib/blitz/home/.claude/projects
install -d -o 1000 -g 1000 /var/lib/blitz/home/.codex/sessions
install -d -o 1000 -g 1000 /var/lib/blitz/workspace/shared/agent-usage
`;
  const usageMounts = options.usageCapture !== true
    ? ""
    : `  --mount type=bind,src=/var/lib/blitz/home/.claude/projects,dst=/workspace/shared/agent-usage/claude,readonly \\
  --mount type=bind,src=/var/lib/blitz/home/.codex/sessions,dst=/workspace/shared/agent-usage/codex,readonly \\
`;
  const promptSender = recipe?.harness !== "chat"
    ? ""
    : `cat >/var/lib/blitz/recipe/sender.cjs <<'RECIPE_SENDER'
${recipeSenderSource(recipe)}
RECIPE_SENDER
chown 1000:1000 /var/lib/blitz/recipe/sender.cjs
chmod 0600 /var/lib/blitz/recipe/sender.cjs
echo "blitz bootstrap: recipe prompt sender starting in the background (best-effort)"
nohup docker exec \\
  --user 1000:1000 \\
  --env HOME=/var/lib/blitz/home \\
  --env USER=blitz \\
  blitz-box \\
  node /var/lib/blitz/recipe/sender.cjs >>/var/lib/blitz/recipe/sender.log 2>&1 &

`;
  // Unconditional on every create: pre-creates the webApp's default terminal
  // tab session (tab id 3 -> tmux session `term-3`; blitz-term's
  // `tmux new-session -A` then attaches instead of starting a shell), so the
  // tab opens onto the running remote-control TUI. Emitted after box health
  // and after the recipe segments. /opt/blitz/npm/bin/claude bypasses the
  // /usr/local/bin/claude PATH shim so no OAuth token is injected
  // (remote-control rejects CLAUDE_CODE_OAUTH_TOKEN and needs an interactive
  // claude.ai login); the `env -u` flags defend against template-env
  // injection; `|| true` keeps bootstrap fail-open.
  const remoteControlSession =
    "docker exec --user 1000:1000 --env HOME=/var/lib/blitz/home --env USER=blitz blitz-box tmux -u new-session -d -s term-3 -c /workspace env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY /opt/blitz/npm/bin/claude remote-control || true\n\n";

  // ---- TEMPLATES-V2 repo cloner (keep as one self-contained segment) ----
  // "" on every create without template repos, so the emitted bytes stay
  // identical and every existing bootstrap pin holds. With repos it starts
  // one detached best-effort retry loop inside the box: each pass skips
  // repos that already have a .git (idempotent across reboots) and retries
  // every 5s for up to 10 minutes, because cloning can only succeed once
  // registration completes and the baked /etc/gitconfig credential helper
  // (`blitz-cred git-helper`, CP-direct) can mint. `|| true` overall: a
  // failed clone never fails the boot; output lands in
  // /var/lib/blitz/repo-clone.log.
  const repos = options.repos ?? [];
  for (const repo of repos) {
    // The save-time validator is the real gate; this re-check keeps the
    // shell-interpolation boundary local to the emitter.
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
      throw new Error(`template repo is not owner/name shaped: ${repo}`);
    }
  }
  const repoCloneAttempts = repos.map((repo) => {
    const directory = repo.slice(repo.indexOf("/") + 1);
    return `  [ -d /workspace/${directory}/.git ] || git clone https://github.com/${repo} /workspace/${directory} || cloned=false`;
  }).join("\n");
  const repoCloner = repos.length === 0
    ? ""
    : `echo "blitz bootstrap: template repo cloner starting in the background (best-effort)"
nohup docker exec \\
  --user 1000:1000 \\
  --env HOME=/var/lib/blitz/home \\
  --env USER=blitz \\
  blitz-box \\
  sh -c 'deadline=$(( $(date +%s) + 600 ))
while :; do
  cloned=true
${repoCloneAttempts}
  [ "$cloned" = true ] && { echo "template repos cloned"; break; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "template repo clone gave up after 600 seconds"; break; }
  sleep 5
done' >>/var/lib/blitz/repo-clone.log 2>&1 || true &

`;
  // ---- end TEMPLATES-V2 repo cloner ----

  const sshPublicKeyDeclaration = sshPublicKey === undefined
    ? ""
    : `readonly SSH_PUBLIC_KEY=${shellQuote(sshPublicKey)}\n`;
  const sshPublicKeyProvisioning = sshPublicKey === undefined
    ? String.raw`: >/var/lib/blitz/authorized_key
chown root:root /var/lib/blitz/authorized_key
chmod 0644 /var/lib/blitz/authorized_key
`
    : String.raw`printf '%s\n' "$SSH_PUBLIC_KEY" >/var/lib/blitz/authorized_key
chown root:root /var/lib/blitz/authorized_key
chmod 0644 /var/lib/blitz/authorized_key
`;

  return String.raw`#!/bin/bash
set -Eeuo pipefail

${sshPublicKeyDeclaration}readonly PHONE_HOME_URL=${shellQuote(options.phoneHomeUrl)}
readonly CONTROL_PLANE_ORIGIN=${shellQuote(controlPlaneOrigin)}
readonly BOX_IMAGE_REF=${shellQuote(options.boxImageRef)}
readonly BOX_IMAGE_TAG=${shellQuote(options.boxImageTag)}
readonly BOX_IMAGE_SHA256=${shellQuote(options.boxImageSha256)}
readonly BOOTSTRAP_ERROR_MAX_BYTES=1006

bootstrap_error=""

sanitize_bootstrap_error() {
  printf '%s' "$1" |
    tr '\000-\037\177' ' ' |
    sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//' |
    LC_ALL=C cut -c 1-"$BOOTSTRAP_ERROR_MAX_BYTES"
}

report_bootstrap_failure() {
  local status="$1"
  local line="$2"
  local message
  trap - ERR
  message=${"${bootstrap_error:-bootstrap failed at line $line (exit $status)}"}
  message=$(sanitize_bootstrap_error "$message")
  if [ -z "$message" ]; then
    message="bootstrap failed at line $line (exit $status)"
  fi
  curl \
    --silent \
    --show-error \
    --max-time 15 \
    --request POST \
    --data-urlencode "bootstrap_error=$message" \
    --output /dev/null \
    "$PHONE_HOME_URL" || true
  exit "$status"
}

trap 'report_bootstrap_failure "$?" "$LINENO"' ERR

readonly BOOTSTRAP_LOG=/var/log/blitz-bootstrap.log
readonly DURABLE_BOOTSTRAP_LOG=/var/lib/blitz/bootstrap.log
touch "$BOOTSTRAP_LOG"
chmod 0600 "$BOOTSTRAP_LOG"
exec >>"$BOOTSTRAP_LOG" 2>&1

fail() {
  bootstrap_error="$*"
  echo "blitz bootstrap failed: $*"
  return 1
}

export DEBIAN_FRONTEND=noninteractive
# Canonical's regional EC2 mirrors (<region>.ec2.archive.ubuntu.com) accept the TCP
# connection and then never answer. Without a timeout apt blocks forever, retry
# never sees a failure to act on, and the workspace sits in creating until the
# caller gives up instead of reporting an error. These timeouts turn that hang
# into a failure; the probe below then moves off the dead mirror.
cat >/etc/apt/apt.conf.d/99blitz-acquire <<'APTCONF'
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::Retries "2";
APTCONF
# apt-get update exits 0 even when every component of a source is Ign:, so its exit
# code cannot gate the fallback. Probe the configured mirror directly instead and
# rewrite before the first update, or the package lists are silently incomplete and
# the docker.io install fails later for a reason that looks unrelated.
ec2_mirror=$(grep -rhoE 'https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com' \
  /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -1)
if [ -n "$ec2_mirror" ] && ! curl -fsS -m 10 -o /dev/null "$ec2_mirror/ubuntu/dists/noble/InRelease"; then
  echo "blitz: $ec2_mirror is unreachable; falling back to archive.ubuntu.com"
  sed -i -E 's|https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com|http://archive.ubuntu.com|g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true
fi
# The probe above catches a dead mirror; a live one can still trickle at
# hundreds of KB/s, which passes every timeout while turning a 90-second
# install into a 20-minute hang. Cap each attempt and move to the fallback
# mirror between attempts — a stall is a failure, not a wait.
apt_mirror_fallback() {
  sed -i -E 's|https?://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com|http://archive.ubuntu.com|g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true
}
apt_watchdog() {
  local attempt
  for attempt in 1 2 3; do
    if timeout 360 apt-get "$@"; then return 0; fi
    echo "blitz: apt-get $1 failed or stalled (attempt $attempt); switching to the fallback mirror"
    apt_mirror_fallback
    dpkg --configure -a 2>/dev/null || true
    sleep 5
  done
  fail "apt-get $1 kept failing or stalling after the mirror fallback"
}
apt_watchdog update
apt_watchdog install -y docker.io curl
systemctl enable --now docker

mkdir -p /var/lib/blitz
volume_device=""
for candidate in /dev/disk/by-id/scsi-0HC_Volume_*; do
  [ -e "$candidate" ] || continue
  volume_device=$(readlink -f "$candidate")
  break
done

if [ -n "$volume_device" ]; then
  blkid_status=0
  blkid "$volume_device" >/dev/null 2>&1 || blkid_status=$?
  case "$blkid_status" in
    0)
      ;;
    2)
      mkfs.ext4 -F "$volume_device"
      ;;
    *)
      fail "blkid failed for $volume_device with status $blkid_status"
      ;;
  esac

  if ! mountpoint -q /var/lib/blitz; then
    mount "$volume_device" /var/lib/blitz
  fi
  volume_uuid=$(blkid -s UUID -o value "$volume_device")
  [ -n "$volume_uuid" ] || fail "mounted volume has no UUID"
  fstab_entry="UUID=$volume_uuid /var/lib/blitz ext4 defaults,nofail 0 2"
  grep -Fqx "$fstab_entry" /etc/fstab || printf '%s\n' "$fstab_entry" >>/etc/fstab
fi

touch "$DURABLE_BOOTSTRAP_LOG"
chmod 0600 "$DURABLE_BOOTSTRAP_LOG"
cat "$BOOTSTRAP_LOG" >"$DURABLE_BOOTSTRAP_LOG"
exec > >(tee -a "$BOOTSTRAP_LOG" "$DURABLE_BOOTSTRAP_LOG" >/dev/null) 2>&1

cat >/usr/local/sbin/blitz-volume-shutdown <<'SHUTDOWN_HOOK'
#!/bin/sh
set -eu
sync
if mountpoint -q /var/lib/blitz; then
  umount /var/lib/blitz
fi
SHUTDOWN_HOOK
chmod 0755 /usr/local/sbin/blitz-volume-shutdown

cat >/etc/systemd/system/blitz-volume-shutdown.service <<'SHUTDOWN_UNIT'
[Unit]
Description=Flush and unmount the Blitz volume during ACPI shutdown
Before=docker.service umount.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/usr/local/sbin/blitz-volume-shutdown

[Install]
WantedBy=multi-user.target
SHUTDOWN_UNIT
systemctl daemon-reload
systemctl enable --now blitz-volume-shutdown.service

mkdir -p /var/lib/blitz/workspace
${sshPublicKeyProvisioning}
# A retained volume belongs to the previous box identity. Its token family is
# revoked when that workspace is destroyed, and allowing the box init to see
# those files makes its register one-shot fail before sshd can start. The new
# credentials are installed after this VM proves its host key to phone-home.
rm -f /var/lib/blitz/box-credential.json /var/lib/blitz/origin

# Ubuntu 24.04 activates sshd through ssh.socket on port 22. Validate the
# replacement listener before stopping that socket so Docker can safely claim
# host port 22 without losing the host SSH recovery path.
install -d -m 0755 /etc/ssh/sshd_config.d
# 00- sorts ahead of image drop-ins; sshd takes the first Port it sees.
cat >/etc/ssh/sshd_config.d/00-blitz.conf <<'SSHD_CONFIG'
Port 2222
SSHD_CONFIG
install -d -o root -g root -m 0755 /run/sshd
/usr/sbin/sshd -t
# Stop both units (a scanner-activated sshd holds the :22 fd itself), then
# mask the socket so no postinst or preset re-apply can put :22 back.
systemctl stop ssh.service ssh.socket 2>/dev/null || true
systemctl disable ssh.socket 2>/dev/null || true
systemctl mask ssh.socket
systemctl enable ssh
systemctl restart ssh
# Prove the move by behavior, not by config parsing: a listener on :2222 is
# the invariant every failure mode violates.
sshd_moved_deadline=$((SECONDS + 20))
until ss -tln 2>/dev/null | grep -qE ':2222[[:space:]]'; do
  if (( SECONDS >= sshd_moved_deadline )); then
    ss -tlnp 2>/dev/null || true
    ls -la /etc/ssh/sshd_config.d/ || true
    fail "host sshd never bound :2222 after the config move"
  fi
  sleep 1
done

# systemctl returns as soon as it has signalled the unit, not once the old
# listener has released the port. The box container binds host port 22, so
# racing ahead here makes docker run die with
# "failed to bind host port 0.0.0.0:22/tcp: address already in use" (exit 125)
# on whichever boots fast enough to lose the race. Wait for the port to be
# genuinely free, and say so plainly if it never is.
port_22_free() {
  ! ss -tln 2>/dev/null | grep -qE '(^|[^0-9.:])(0\.0\.0\.0|\[::\]|\*):22[[:space:]]'
}
sshd_release_deadline=$((SECONDS + 60))
until port_22_free; do
  if (( SECONDS >= sshd_release_deadline )); then
    ss -tlnp 2>/dev/null | grep ':22 ' || true
    fail "host sshd still holds port 22 after 60s; the box container cannot bind it"
  fi
  sleep 1
done

${imageSetup}
install -d -m 0755 /etc/blitz
docker run --rm --entrypoint cat "$box_image" /etc/blitz/env.defaults >/etc/blitz/env.defaults
chmod 0644 /etc/blitz/env.defaults
${invocationFiles}${usageDirectories}docker run --detach \
  --name blitz-box \
  --restart unless-stopped \
  --privileged \
  --env-file /etc/blitz/env.defaults \
  -e BLITZ_UID=1000 \
  -e BLITZ_GID=1000 \
${agentFlag}  --mount type=bind,src=/var/lib/blitz,dst=/var/lib/blitz \
  --mount type=bind,src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly \
  --mount type=bind,src=/var/lib/blitz/workspace,dst=/workspace \
${usageMounts}  -p 0.0.0.0:22:22 \
  "$box_image"

health_deadline=$((SECONDS + 180))
box_healthy=false
while (( SECONDS < health_deadline )); do
  if [ "$(docker inspect --format '{{.State.Running}}' blitz-box 2>/dev/null || true)" = true ] &&
    docker exec blitz-box ssh-keyscan -T 2 -p 22 127.0.0.1 >/dev/null 2>&1 &&
    docker exec blitz-box test -s /var/lib/blitz/ssh/ssh_host_ed25519_key.pub; then
    box_healthy=true
    break
  fi
  sleep 3
done
[ "$box_healthy" = true ] || fail "box health timeout after 180 seconds"

${promptSender}${remoteControlSession}${repoCloner}read_host_key() {
  local key_path="/var/lib/blitz/ssh/ssh_host_$1_key.pub"
  if [ -s "$key_path" ]; then
    sed -n '1p' "$key_path"
  fi
}

pub_key_ecdsa=$(read_host_key ecdsa)
pub_key_ed25519=$(read_host_key ed25519)
pub_key_rsa=$(read_host_key rsa)
[ -n "$pub_key_ed25519" ] || fail "box Ed25519 host public key is missing"

credential_tmp=$(mktemp /var/lib/blitz/.box-credential.XXXXXX)
trap 'rm -f "$credential_tmp"' EXIT
curl \
  --fail-with-body \
  --silent \
  --show-error \
  --retry 10 \
  --retry-all-errors \
  --retry-delay 3 \
  --request POST \
  --data-urlencode "pub_key_ecdsa=$pub_key_ecdsa" \
  --data-urlencode "pub_key_ed25519=$pub_key_ed25519" \
  --data-urlencode "pub_key_rsa=$pub_key_rsa" \
  --output "$credential_tmp" \
  "$PHONE_HOME_URL"
[ -s "$credential_tmp" ] || fail "phone-home returned an empty credential"
python3 - "$credential_tmp" <<'PYTHON'
import json
import sys

credential_path = sys.argv[1]
with open(credential_path, encoding="utf-8") as response_file:
    response = json.load(response_file)
credential = {
    "box_id": response["box_id"],
    "access_token": response["access_token"],
    "refresh_token": response["refresh_token"],
}
with open(credential_path, "w", encoding="utf-8") as credential_file:
    json.dump(credential, credential_file, separators=(",", ":"))
    credential_file.write("\n")
PYTHON
install -m 0600 -o 1000 -g 1000 "$credential_tmp" /var/lib/blitz/box-credential.json
chmod 0600 /var/lib/blitz/box-credential.json
printf '%s\n' "$CONTROL_PLANE_ORIGIN" >/var/lib/blitz/origin
chown 1000:1000 /var/lib/blitz/origin
chmod 0644 /var/lib/blitz/origin
rm -f "$credential_tmp"
trap - EXIT

echo "blitz bootstrap: credential registration poke start outer_timeout_seconds=40 inner_timeout_seconds=30"
register_status=0
timeout --foreground --kill-after=5s 40s \
  docker exec \
    --user 1000:1000 \
    --env HOME=/var/lib/blitz/home \
    --env USER=blitz \
    blitz-box \
    timeout --foreground --kill-after=5s 30s \
    blitz-cred register ||
  {
    register_status=$?
    echo "blitz bootstrap: credential registration poke failed or timed out (exit $register_status); continuing bootstrap because registration poke is best-effort"
    true
  }
if (( register_status == 0 )); then
  echo "blitz bootstrap: credential registration poke complete"
fi

trap - ERR
echo "blitz bootstrap completed"
`;
}
