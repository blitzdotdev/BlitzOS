import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildBootstrapScript } from "../dist/core/bootstrap.js";
import { embeddedSection } from "./emitted-script.mjs";

// Text pins prove what the emitter writes; they cannot prove what bash does
// with it (the same reason test/bootstrap-bash.test.mjs exists). The host
// updater replaces a container that holds every process in a workspace, so
// its order of operations is the whole safety argument: pull before remove,
// roll back on a start that never comes up, report either way. This suite
// runs the emitted `blitz-box-run` and `blitz-box-update` in real bash,
// against a real control plane over real curl, with a scripted docker.

const BOOTSTRAP = buildBootstrapScript({
  boxImageSha256: "",
  boxImageRef: "ghcr.io/blitzdotdev/blitz-box:test",
  boxImageTag: "",
  phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
  sshPublicKey: "ssh-ed25519 AAAAcaller",
});

const RUNNING_REF = "ghcr.io/blitzdotdev/blitz-box:v1";
const NEXT_REF = "ghcr.io/blitzdotdev/blitz-box:v2";

/** The emitted script with the three absolute prefixes it owns repointed at a
 * scratch tree, so a test never reads or writes the machine's own state. The
 * bytes are otherwise untouched. */
function relocate(body, root) {
  return body
    .replaceAll("/usr/local/bin/blitz-box-run", path.join(root, "bin/blitz-box-run"))
    .replaceAll("/usr/local/sbin/blitz-box-image", path.join(root, "bin/blitz-box-image"))
    .replaceAll("/etc/blitz", path.join(root, "etc/blitz"))
    .replaceAll("/var/lib/blitz", path.join(root, "state"));
}

/** Widens the two ref globs from `https://` to `http*://`, and nothing else.
 *
 * R2 is https and the emitted script is right to say so, but a test cannot
 * hand curl a trusted certificate for 127.0.0.1. Both globs move together, so
 * the branch this suite exercises is still the real one: manifest URL versus
 * any other https ref versus a registry ref, in that order. The `https?://`
 * inside the box-config parser's regex does not match this literal and is
 * left alone. */
function relocateImageHost(body) {
  return body
    .replace("  https://*/manifest.json)", "  http*://*/manifest.json)")
    .replace("  https://*)", "  http*://*)");
}

/** A scratch VM host: the emitted blitz-box-run, a docker whose every call is
 * recorded and whose outcomes the test dictates, and a chown that records the
 * ownership the updater asks for (a test does not run as root). `refuseRun`
 * names the image refs whose `docker run` fails the way a real one does when
 * the image cannot start — a bad platform, or host port 22 already bound.
 *
 * The manifest path adds a local image store: `storedImages` is what
 * `docker image inspect <tag>` already answers to, `loadProduces` is the tag a
 * successful `docker load` puts there, and `refuseLoad` makes the load fail
 * the way a truncated archive does. */
function scratchHost({
  pullStatus = 0,
  refuseRun = [],
  runningRef = RUNNING_REF,
  storedImages = [],
  loadProduces = "",
  refuseLoad = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "blitz-box-update-"));
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  mkdirSync(path.join(root, "etc/blitz"), { recursive: true });
  writeFileSync(path.join(root, "etc/blitz/env.defaults"), "BLITZ_FROM=old-image\n");
  if (runningRef !== null) {
    writeFileSync(path.join(root, "container.image"), runningRef);
    writeFileSync(path.join(root, "container.running"), "true");
  }
  writeFileSync(path.join(root, "bin/blitz-box-run"), relocate(embeddedSection(BOOTSTRAP, "BOX_RUN"), root));
  chmodSync(path.join(root, "bin/blitz-box-run"), 0o755);
  // The one host image installer, the same bytes the first boot uses. The
  // updater shells out to it, so the manifest path under test here is the
  // production one rather than a second copy written for the test.
  writeFileSync(
    path.join(root, "bin/blitz-box-image"),
    relocate(embeddedSection(BOOTSTRAP, "BOX_IMAGE_INSTALL"), root),
  );
  chmodSync(path.join(root, "bin/blitz-box-image"), 0o755);
  writeFileSync(path.join(root, "refuse-run"), `${refuseRun.join("\n")}\n`);
  writeFileSync(path.join(root, "stored.images"), `${storedImages.join("\n")}\n`);
  writeFileSync(path.join(root, "load-produces"), loadProduces);

  // `docker run --detach` is the container start and its image is the last
  // argument; `docker run --rm --entrypoint cat IMAGE PATH` is the
  // env.defaults read. Everything else the updater calls is answered from the
  // files that stand in for the daemon's view of blitz-box and of its store.
  const docker = `#!/bin/bash
printf '%s\\n' "$*" >>"${root}/docker.argv"
case "$*" in
  "inspect --format {{.Config.Image}} blitz-box")
    [ -f "${root}/container.image" ] || exit 1
    cat "${root}/container.image" ;;
  "inspect --format {{.State.Running}} blitz-box")
    [ -f "${root}/container.running" ] || exit 1
    cat "${root}/container.running" ;;
  "image inspect "*)
    grep -qxF "$3" "${root}/stored.images" ;;
  "load")
    cat >"${root}/loaded.archive"
    ${refuseLoad ? 'echo "docker: unexpected EOF" >&2; exit 1' : `cat "${root}/load-produces" >>"${root}/stored.images"`} ;;
  "pull "*) exit ${pullStatus} ;;
  "rm -f blitz-box")
    rm -f "${root}/container.image" "${root}/container.running" ;;
  "run --rm --entrypoint cat "*)
    printf 'BLITZ_FROM=%s\\n' "$5" ;;
  "run --detach"*)
    image=\${!#}
    if grep -qxF "$image" "${root}/refuse-run"; then
      echo "docker: refusing to start $image" >&2
      exit 125
    fi
    printf '%s' "$image" >"${root}/container.image"
    printf 'true' >"${root}/container.running" ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(path.join(root, "bin/docker"), docker);
  chmodSync(path.join(root, "bin/docker"), 0o755);
  writeFileSync(
    path.join(root, "bin/chown"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${root}/chown.argv"\n`,
  );
  chmodSync(path.join(root, "bin/chown"), 0o755);
  return root;
}

/** A control plane the emitted curl really talks to. `boxConfig` is called
 * with the plane's own origin, so a test can serve either that origin (the
 * steady state) or a different one (the domain move). Every update-result
 * report is recorded with its Authorization header.
 *
 * `assets` serves the box-image manifest and its parts as plain bytes, which
 * is what R2 is to the host. `token` makes the plane demand a live box access
 * token and rotate it at `/oauth/token`, which is the only way to exercise the
 * updater's own credential refresh: a real box token lives 15 minutes and this
 * timer runs every 5, so the 401 is a state every long-lived box reaches. */
async function controlPlane(boxConfig, { assets = new Map(), token = null } = {}) {
  const reports = [];
  const grants = [];
  const live = token === null ? null : { access: token.access, refresh: token.refresh };
  const refused = [];
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const asset = assets.get(request.url);
    if (asset !== undefined) {
      response.statusCode = asset.status ?? 200;
      response.end(asset.body);
      return;
    }
    if (request.url === "/oauth/token") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        grants.push(Object.fromEntries(form));
        if (live === null || form.get("refresh_token") !== live.refresh) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        live.access = `${live.access}-rotated`;
        live.refresh = `${live.refresh}-rotated`;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          box_id: "box",
          access_token: live.access,
          refresh_token: live.refresh,
          token_type: "Bearer",
          expires_in: 900,
        }));
      });
      return;
    }
    // Everything below is box-authenticated. A plane with a `token` refuses a
    // stale one exactly as the real oauth check does.
    if (live !== null && request.headers.authorization !== `Bearer ${live.access}`) {
      refused.push(request.url);
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid box access token" }));
      return;
    }
    if (request.url === "/workspaces/self/box-config") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(boxConfig(origin)));
      return;
    }
    if (request.url === "/workspaces/self/box-update-result") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        reports.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    reports,
    grants,
    refused,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A box image served the way canary serves it: one gzip archive split into
 * parts, each with its own SHA-256, behind a manifest that names the tag the
 * archive loads as. Returns the assets to serve and the manifest URL to pin. */
function manifestAssets({ imageTag, parts = 2, corruptPart = null, missingPart = null }) {
  const payload = Buffer.from(`box image payload for ${imageTag}`.repeat(64));
  const archive = gzipSync(payload);
  const size = Math.ceil(archive.length / parts);
  const assets = new Map();
  const entries = [];
  for (let index = 0; index < parts; index += 1) {
    const name = `part-${String(index)}`;
    const bytes = archive.subarray(index * size, (index + 1) * size);
    entries.push({ name, sha256: digest(bytes) });
    if (name === missingPart) assets.set(`/box-image/${name}`, { status: 404, body: "" });
    // A corrupt part keeps the digest the manifest promises and serves other
    // bytes, which is exactly what a truncated or tampered object looks like.
    else if (name === corruptPart) assets.set(`/box-image/${name}`, { body: Buffer.from("tampered") });
    else assets.set(`/box-image/${name}`, { body: bytes });
  }
  assets.set("/box-image/manifest.json", {
    body: JSON.stringify({ imageTag, totalSha256: digest(archive), parts: entries }),
  });
  // `payload` is what docker load actually receives: the updater pipes the
  // reassembled archive through gunzip, so asserting on it proves the parts
  // were concatenated in manifest order and decompressed whole.
  return {
    assets,
    ref: "/box-image/manifest.json",
    archive,
    payload,
    totalSha256: digest(archive),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Runs the emitted updater under `bash -x`, asynchronously: the control
 * plane it curls lives in this process, so a synchronous spawn would block
 * the very event loop that has to answer. A run that dies under `set -e`
 * prints nothing of its own, so the trace names the command that killed it. */
async function runUpdater(
  root,
  { origin, token = "box-access-token", refresh = "box-refresh-token" } = {},
) {
  if (origin !== null) writeFileSync(path.join(root, "state/origin"), `${origin}\n`);
  if (token !== null) {
    writeFileSync(
      path.join(root, "state/box-credential.json"),
      `${JSON.stringify({ box_id: "box", access_token: token, refresh_token: refresh })}\n`,
    );
  }
  const scriptPath = path.join(root, "blitz-box-update");
  writeFileSync(scriptPath, relocateImageHost(relocate(embeddedSection(BOOTSTRAP, "BOX_UPDATER"), root)));
  const result = await new Promise((resolve) => {
    const child = spawn("bash", ["-x", scriptPath], {
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}` },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.resume();
    child.on("close", (status) => resolve({ status, stderr }));
  });
  const trace = result.stderr.trimEnd().split("\n").slice(-6).join("\n");
  return {
    status: result.status,
    report: `bash exited ${result.status}; last trace:\n${trace}`,
    dockerCalls: readOptional(path.join(root, "docker.argv")).split("\n").filter(Boolean),
    log: readOptional(path.join(root, "state/box-update.log")),
    origin: readOptional(path.join(root, "state/origin")).trim(),
    image: readOptional(path.join(root, "container.image")),
    running: readOptional(path.join(root, "container.running")),
    envDefaults: readOptional(path.join(root, "etc/blitz/env.defaults")),
    chownCalls: readOptional(path.join(root, "chown.argv")).split("\n").filter(Boolean),
  };
}

/** The steady-state box-config: this plane's own origin, update requested.
 * `boxImageSha256` is the deployment's pinned digest of the whole archive;
 * empty is what a registry pin sends, and the manifest tests below pass the
 * real one. */
function configFor(boxImageRef, planeOrigin, boxImageSha256 = "") {
  return { boxImageRef, boxImageSha256, controlPlaneOrigin: planeOrigin, updateRequested: true };
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** A scratch host and a live control plane for the length of one body. */
async function withHost(hostOptions, boxConfig, body, planeOptions = {}) {
  const root = scratchHost(hostOptions);
  const plane = await controlPlane(boxConfig, planeOptions);
  try {
    await body(root, plane, (options) => runUpdater(root, { origin: plane.origin, ...options }));
  } finally {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The credential file as the updater reads it back after a run. */
function credential(root) {
  return JSON.parse(readOptional(path.join(root, "state/box-credential.json")));
}

// The domain move that caused the fleet-wide websocket outage: the box-config
// names an origin the file on disk does not carry. The refresh is unconditional
// on every poll and needs no restart, because the gateway re-reads the file.
test("a poll with no update requested refreshes the origin and touches no container", async () => {
  const moved = "https://blitzos.example";
  await withHost(
    {},
    () => ({
      boxImageRef: NEXT_REF,
      boxImageSha256: "",
      controlPlaneOrigin: moved,
      updateRequested: false,
    }),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.equal(result.origin, moved);
      assert.equal(result.chownCalls.length, 1);
      assert.match(result.chownCalls[0], /^1000:1000 /u);
      assert.deepEqual(result.dockerCalls, []);
      assert.match(result.log, /origin refreshed/u);
      assert.deepEqual(plane.reports, []);
      assert.ok(root);
    },
  );
});

test("a requested update pulls, replaces, and reports updated", async () => {
  await withHost({}, (planeOrigin) => configFor(NEXT_REF, planeOrigin), async (root, plane, run) => {
    const result = await run();
    assert.equal(result.status, 0, result.report);
    assert.deepEqual(result.dockerCalls.slice(0, 3), [
      "inspect --format {{.Config.Image}} blitz-box",
      `pull ${NEXT_REF}`,
      "rm -f blitz-box",
    ]);
    assert.equal(result.image, NEXT_REF);
    // The container env is re-read from the image that is about to run, so a
    // new image's defaults are not shadowed by the old file.
    assert.equal(result.envDefaults, `BLITZ_FROM=${NEXT_REF}\n`);
    assert.equal(plane.reports.length, 1);
    assert.equal(plane.reports[0].authorization, "Bearer box-access-token");
    // `tag` is the image the container runs NOW. On a clean update that is the
    // new ref; the failure cases below prove it is the OLD one when nothing
    // was replaced, which is what makes it answer "is an update available".
    assert.equal(
      plane.reports[0].body,
      JSON.stringify({ ref: NEXT_REF, outcome: "updated", tag: NEXT_REF }),
    );
    assert.equal(readOptional(path.join(root, "state/origin")).trim(), plane.origin);
  });
});

test("a failed pull leaves the running container untouched", async () => {
  await withHost(
    { pullStatus: 1 },
    (planeOrigin) => configFor(NEXT_REF, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(
        !result.dockerCalls.includes("rm -f blitz-box"),
        `the updater removed the container after a failed pull: ${result.dockerCalls.join(" | ")}`,
      );
      assert.equal(result.image, RUNNING_REF);
      assert.equal(readOptional(path.join(root, "container.running")), "true");
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({ ref: NEXT_REF, outcome: "pull-failed", tag: RUNNING_REF }),
      );
    },
  );
});

// A new image that cannot start is the case that decides whether a workspace
// survives: the old container is already gone, so the updater has to bring it
// back and say so.
test("a new image that refuses to start rolls back to the old ref", async () => {
  await withHost(
    { refuseRun: [NEXT_REF] },
    (planeOrigin) => configFor(NEXT_REF, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      // The rollback start is the last docker run, and it names the old ref.
      const runs = result.dockerCalls.filter((call) => call.startsWith("run --detach"));
      assert.equal(runs.length, 2);
      assert.match(runs[0], new RegExp(`${NEXT_REF}$`, "u"));
      assert.match(runs[1], new RegExp(`${RUNNING_REF}$`, "u"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(result.running, "true");
      // Rolling back restores the old image's env file too.
      assert.equal(result.envDefaults, `BLITZ_FROM=${RUNNING_REF}\n`);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({ ref: NEXT_REF, outcome: "rolled-back", tag: RUNNING_REF }),
      );
      assert.match(result.log, /rollback complete/u);
      assert.ok(root);
    },
  );
});

// The worst path: neither image starts. Nothing is left running, and the
// control plane still hears about it, so the flag clears instead of retrying
// the same swap every five minutes.
test("a rollback that also fails reports start-failed and still clears the flag", async () => {
  await withHost(
    { refuseRun: [NEXT_REF, RUNNING_REF] },
    (planeOrigin) => configFor(NEXT_REF, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.equal(result.image, "");
      // Nothing is running, so there is no image to name and the producer omits
      // the key rather than reporting an empty one.
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({ ref: NEXT_REF, outcome: "start-failed" }),
      );
      assert.match(result.log, /rollback failed/u);
      assert.ok(root);
    },
  );
});

test("a requested update to the ref already running clears the flag without pulling", async () => {
  await withHost({}, (planeOrigin) => configFor(RUNNING_REF, planeOrigin), async (root, plane, run) => {
    const result = await run();
    assert.equal(result.status, 0, result.report);
    // Two reads and nothing else: the up-to-date check, then the report's own
    // read of the image still running. No pull, no removal, no restart.
    assert.deepEqual(result.dockerCalls, [
      "inspect --format {{.Config.Image}} blitz-box",
      "inspect --format {{.Config.Image}} blitz-box",
    ]);
    assert.equal(
      plane.reports[0].body,
      JSON.stringify({ ref: RUNNING_REF, outcome: "up-to-date", tag: RUNNING_REF }),
    );
    assert.ok(root);
  });
});

// An https ref the host cannot resolve to an image is the one case that stays
// unsupported. Every emitted updater before the manifest branch reported this
// for EVERY https ref, which is how the UI recognises a machine that can never
// update itself in place.
test("an https ref that is not a manifest reports unsupported and still refreshes the origin", async () => {
  const tarball = "https://cp.example/box-image/image.tar.gz";
  await withHost({}, (planeOrigin) => configFor(tarball, planeOrigin), async (root, plane, run) => {
    const result = await run();
    assert.equal(result.status, 0, result.report);
    assert.ok(!result.dockerCalls.some((call) => call.startsWith("pull")));
    assert.equal(result.image, RUNNING_REF);
    assert.equal(
      plane.reports[0].body,
      JSON.stringify({ ref: tarball, outcome: "unsupported", tag: RUNNING_REF }),
    );
    assert.equal(readOptional(path.join(root, "state/origin")).trim(), plane.origin);
  });
});

test("a box that has not enrolled yet polls nothing and fails nothing", async () => {
  await withHost({}, (planeOrigin) => configFor(NEXT_REF, planeOrigin), async (root, plane) => {
    rmSync(path.join(root, "state/box-credential.json"), { force: true });
    rmSync(path.join(root, "state/origin"), { force: true });
    const result = await runUpdater(root, { origin: null, token: null });
    assert.equal(result.status, 0, result.report);
    assert.deepEqual(result.dockerCalls, []);
    assert.equal(result.log, "");
    assert.deepEqual(plane.reports, []);
  });
});

test("a box-config the contract rejects changes nothing on the host", async () => {
  await withHost(
    {},
    (planeOrigin) => configFor("not a ref", planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.deepEqual(result.dockerCalls, []);
      assert.match(result.log, /poll rejected/u);
      assert.deepEqual(plane.reports, []);
      assert.ok(root);
    },
  );
});

// ---- the manifest branch (canary's mode B) ----
//
// Canary pins BOX_IMAGE_REF to an https R2 manifest, and every updater before
// this branch refused it outright: no canary box could ever update in place.
// The manifest names the tag, so the host learns what it is being asked for
// only after fetching it — which is also why the ref alone can never answer
// "is an update available" here.

const MANIFEST_TAG = "blitz-box:2026-08-31";

test("a manifest ref downloads, verifies, loads and replaces the container", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG });
  await withHost(
    { loadProduces: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      // The parts are concatenated in manifest order and the whole archive is
      // what reaches docker load, byte for byte.
      assert.deepEqual(readFileSync(path.join(root, "loaded.archive")), image.payload);
      assert.equal(result.image, MANIFEST_TAG);
      assert.equal(result.running, "true");
      // The new image's env defaults replaced the old file, same as a pull.
      assert.equal(result.envDefaults, `BLITZ_FROM=${MANIFEST_TAG}\n`);
      assert.ok(!result.dockerCalls.some((call) => call.startsWith("pull")));
      assert.match(result.log, /update complete/u);
      // `ref` is the manifest URL the deployment pins; `tag` is the image that
      // URL resolved to. Only the second can be compared against a machine.
      assert.equal(plane.reports.length, 1);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "updated",
          tag: MANIFEST_TAG,
        }),
      );
    },
    { assets: image.assets },
  );
});

// The security case. A part whose bytes do not match the digest the manifest
// promises is a corrupt or tampered archive, and it must never be loaded — nor
// may it disturb the container that is running fine.
test("a part that fails its digest is never loaded and leaves the container running", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG, corruptPart: "part-1" });
  await withHost(
    { loadProduces: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(
        !result.dockerCalls.includes("load"),
        `a mismatched archive reached docker load: ${result.dockerCalls.join(" | ")}`,
      );
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(result.running, "true");
      // The installer's exit code is what the updater turns into the outcome.
      assert.match(result.log, /image install exited 11/u);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "digest-mismatch",
          tag: RUNNING_REF,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});

test("a part that does not download reports download-failed and touches nothing", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG, missingPart: "part-0" });
  await withHost(
    { loadProduces: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(!result.dockerCalls.includes("load"));
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "download-failed",
          tag: RUNNING_REF,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});

test("an archive docker load refuses reports load-failed and leaves the container running", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG });
  await withHost(
    { refuseLoad: true },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "load-failed",
          tag: RUNNING_REF,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});

// The ref does not move between rebakes under a manifest pin, so this is the
// case a five-minute timer hits over and over once a box is current. It must
// cost one manifest fetch and no download at all.
test("a manifest whose tag already runs reports up-to-date without downloading parts", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG });
  await withHost(
    { runningRef: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(!result.dockerCalls.includes("load"));
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, MANIFEST_TAG);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "up-to-date",
          tag: MANIFEST_TAG,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});

// A previous attempt can have loaded the image and then failed to start it.
// Re-downloading gigabytes to reach layers the store already holds helps
// nobody, so the store is checked before the network is.
test("an image already in the local store is not downloaded again", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG, missingPart: "part-0" });
  await withHost(
    { storedImages: [MANIFEST_TAG] },
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, image.totalSha256),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      // part-0 would 404 if it were fetched, so reaching `updated` at all
      // proves the store was consulted before the network; and nothing was
      // loaded, because there was nothing to load.
      assert.equal(result.image, MANIFEST_TAG);
      assert.ok(!result.dockerCalls.includes("load"));
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "updated",
          tag: MANIFEST_TAG,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});

// ---- the credential the updater holds ----
//
// A box access token lives 15 minutes; this timer runs every 5. Nothing else
// on the VM keeps the on-disk file fresh — the Go client inside the container
// rotates only in reaction to its own 401, which needs somebody to run
// blitz-cred. A quiet box therefore reaches a state where every poll 401s
// forever, the update flag never clears, and the button that set it dies
// silently. That was live on blitzos-dev: file mtime 02:03, 401s from 02:20 on.

test("an expired access token is rotated and the poll retried", async () => {
  await withHost(
    {},
    (planeOrigin) => configFor(NEXT_REF, planeOrigin),
    async (root, plane, run) => {
      const result = await run({ token: "stale-access-token" });
      assert.equal(result.status, 0, result.report);
      // The plane refused the stale token first, then the rotated one worked.
      assert.deepEqual(plane.refused, ["/workspaces/self/box-config"]);
      assert.deepEqual(plane.grants, [
        { grant_type: "refresh_token", refresh_token: "box-refresh-token" },
      ]);
      // The rotation was written back to the file every other reader on the
      // box shares, not just held in this process.
      assert.deepEqual(credential(root), {
        box_id: "box",
        access_token: "live-access-token-rotated",
        refresh_token: "box-refresh-token-rotated",
      });
      // The update itself went through on the rotated token.
      assert.equal(result.image, NEXT_REF);
      assert.equal(plane.reports[0].authorization, "Bearer live-access-token-rotated");
      assert.match(result.log, /credential refresh/u);
    },
    { token: { access: "live-access-token", refresh: "box-refresh-token" } },
  );
});

test("a refresh token the control plane rejects leaves the credential alone", async () => {
  await withHost(
    {},
    (planeOrigin) => configFor(NEXT_REF, planeOrigin),
    async (root, plane, run) => {
      const result = await run({ token: "stale-access-token", refresh: "revoked-refresh-token" });
      // A box whose family was revoked cannot recover on its own, and it must
      // say so rather than replace the container on a guess.
      assert.equal(result.status, 0, result.report);
      assert.deepEqual(result.dockerCalls, []);
      assert.deepEqual(plane.reports, []);
      assert.match(result.log, /credential refresh failed/u);
      assert.match(result.log, /poll failed/u);
      assert.equal(credential(root).refresh_token, "revoked-refresh-token");
    },
    { token: { access: "live-access-token", refresh: "box-refresh-token" } },
  );
});

// The digest the MANIFEST declares is self-certifying: whoever serves the
// manifest serves the digest beside it. The control plane pins its own copy,
// which arrives over a different connection, and the host checks both. This is
// what makes the updater's verification as strong as the first boot's.
test("an archive that does not match the control plane's pinned digest is refused", async () => {
  const image = manifestAssets({ imageTag: MANIFEST_TAG });
  await withHost(
    { loadProduces: MANIFEST_TAG },
    // A manifest that is internally consistent — every part digest and the
    // total agree — and still is not the image this deployment pinned.
    (planeOrigin) => configFor(`${planeOrigin}${image.ref}`, planeOrigin, "c".repeat(64)),
    async (root, plane, run) => {
      const result = await run();
      assert.equal(result.status, 0, result.report);
      assert.ok(
        !result.dockerCalls.includes("load"),
        `an unpinned archive reached docker load: ${result.dockerCalls.join(" | ")}`,
      );
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(
        plane.reports[0].body,
        JSON.stringify({
          ref: `${plane.origin}${image.ref}`,
          outcome: "digest-mismatch",
          tag: RUNNING_REF,
        }),
      );
      assert.ok(root);
    },
    { assets: image.assets },
  );
});
