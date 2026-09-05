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
const MANIFEST_TAG = "blitz-box:manifest-v2";
const MANIFEST_PATH = "/box-image/release-v2/manifest.json";

/** The emitted script with the three absolute prefixes it owns repointed at a
 * scratch tree, so a test never reads or writes the machine's own state. The
 * bytes are otherwise untouched. */
function relocate(body, root) {
  return body
    .replaceAll("/usr/local/bin/blitz-box-run", path.join(root, "bin/blitz-box-run"))
    .replaceAll(
      "/usr/local/libexec/blitz-box-image-manifest.sh",
      path.join(root, "libexec/blitz-box-image-manifest.sh"),
    )
    .replaceAll("/etc/blitz", path.join(root, "etc/blitz"))
    .replaceAll("/var/lib/blitz", path.join(root, "state"))
    .replaceAll("/proc/meminfo", path.join(root, "proc/meminfo"));
}

/** A scratch VM host: the emitted blitz-box-run, a docker whose every call is
 * recorded and whose outcomes the test dictates, and a chown that records the
 * ownership the updater asks for (a test does not run as root). `refuseRun`
 * names the image refs whose `docker run` fails the way a real one does when
 * the image cannot start — a bad platform, or host port 22 already bound. */
function scratchHost({
  loadedTag = null,
  pullStatus = 0,
  refuseRun = [],
  runningRef = RUNNING_REF,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "blitz-box-update-"));
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  mkdirSync(path.join(root, "etc/blitz"), { recursive: true });
  mkdirSync(path.join(root, "proc"), { recursive: true });
  writeFileSync(path.join(root, "proc/meminfo"), "MemTotal:       8388608 kB\n");
  writeFileSync(path.join(root, "etc/blitz/env.defaults"), "BLITZ_FROM=old-image\n");
  if (runningRef !== null) {
    writeFileSync(path.join(root, "container.image"), runningRef);
    writeFileSync(path.join(root, "container.running"), "true");
    writeFileSync(path.join(root, "images"), `${runningRef}\n`);
  }
  if (loadedTag !== null) writeFileSync(path.join(root, "load-tag"), loadedTag);
  writeFileSync(path.join(root, "bin/blitz-box-run"), relocate(embeddedSection(BOOTSTRAP, "BOX_RUN"), root));
  chmodSync(path.join(root, "bin/blitz-box-run"), 0o755);
  mkdirSync(path.join(root, "libexec"));
  writeFileSync(
    path.join(root, "libexec/blitz-box-image-manifest.sh"),
    relocate(embeddedSection(BOOTSTRAP, "BOX_IMAGE_MANIFEST_LOADER"), root),
  );
  writeFileSync(path.join(root, "refuse-run"), `${refuseRun.join("\n")}\n`);

  // `docker run --detach` is the container start and its image is the last
  // argument; `docker run --rm --entrypoint cat IMAGE PATH` is the
  // env.defaults read. Everything else the updater calls is answered from the
  // two files that stand in for the daemon's view of blitz-box.
  const docker = `#!/bin/bash
printf '%s\\n' "$*" >>"${root}/docker.argv"
case "$*" in
  "inspect --format {{.Config.Image}} blitz-box")
    [ -f "${root}/container.image" ] || exit 1
    cat "${root}/container.image" ;;
  "inspect --format {{.State.Running}} blitz-box")
    [ -f "${root}/container.running" ] || exit 1
    cat "${root}/container.running" ;;
  "image inspect "*) grep -qxF "$3" "${root}/images" ;;
  "load")
    cat >"${root}/docker-load.input"
    [ -s "${root}/load-tag" ] || exit 1
    [ "$(cat "${root}/docker-load.input")" = "$(cat "${root}/load-tag")" ] || exit 1
    grep -qxF "$(cat "${root}/load-tag")" "${root}/images" 2>/dev/null ||
      cat "${root}/load-tag" >>"${root}/images"
    printf 'Loaded image: %s\\n' "$(cat "${root}/load-tag")" ;;
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
 * report is recorded with its Authorization header. */
async function controlPlane(boxConfig, assets = new Map()) {
  const reports = [];
  const assetRequests = [];
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/workspaces/self/box-config") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(boxConfig(origin)));
      return;
    }
    const asset = assets.get(request.url);
    if (asset !== undefined) {
      assetRequests.push(request.url);
      response.setHeader(
        "Content-Type",
        request.url.endsWith(".json") ? "application/json" : "application/octet-stream",
      );
      response.end(asset);
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
    assetRequests,
    reports,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs the emitted updater under `bash -x`, asynchronously: the control
 * plane it curls lives in this process, so a synchronous spawn would block
 * the very event loop that has to answer. A run that dies under `set -e`
 * prints nothing of its own, so the trace names the command that killed it. */
async function runUpdater(root, { origin, token = "box-access-token" } = {}) {
  if (origin !== null) writeFileSync(path.join(root, "state/origin"), `${origin}\n`);
  if (token !== null) {
    writeFileSync(
      path.join(root, "state/box-credential.json"),
      `${JSON.stringify({ box_id: "box", access_token: token, refresh_token: "r" })}\n`,
    );
  }
  const scriptPath = path.join(root, "blitz-box-update");
  writeFileSync(scriptPath, relocate(embeddedSection(BOOTSTRAP, "BOX_UPDATER"), root));
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

/** The steady-state box-config: this plane's own origin, update requested. */
function configFor(boxImageRef, planeOrigin) {
  return { boxImageRef, controlPlaneOrigin: planeOrigin, updateRequested: true };
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A tiny gzip split into two manifest parts. The docker stand-in consumes
 * the decompressed tag as its minimal image payload, which proves the real
 * gunzip/pipe/load path without requiring a docker daemon in the test host. */
function manifestAssets({ badPartSha = false } = {}) {
  const archive = gzipSync(Buffer.from(`${MANIFEST_TAG}\n`));
  const split = Math.floor(archive.byteLength / 2);
  const parts = [archive.subarray(0, split), archive.subarray(split)];
  const names = ["image.part-00000", "image.part-00001"];
  const manifest = {
    parts: parts.map((part, index) => ({
      name: names[index],
      sha256: badPartSha && index === 0 ? "0".repeat(64) : sha256(part),
    })),
    totalSha256: sha256(archive),
    imageTag: MANIFEST_TAG,
  };
  return new Map([
    [MANIFEST_PATH, Buffer.from(JSON.stringify(manifest))],
    ...parts.map((part, index) => [
      `${MANIFEST_PATH.slice(0, MANIFEST_PATH.lastIndexOf("/") + 1)}${names[index]}`,
      part,
    ]),
  ]);
}

/** A scratch host and a live control plane for the length of one body. */
async function withHost(hostOptions, boxConfig, body) {
  const root = scratchHost(hostOptions);
  const plane = await controlPlane(boxConfig, hostOptions.assets);
  try {
    await body(root, plane, (options) => runUpdater(root, { origin: plane.origin, ...options }));
  } finally {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// The domain move that caused the fleet-wide websocket outage: the box-config
// names an origin the file on disk does not carry. The refresh is unconditional
// on every poll and needs no restart, because the gateway re-reads the file.
test("a poll with no update requested refreshes the origin and touches no container", async () => {
  const moved = "https://blitzos.example";
  await withHost(
    {},
    () => ({ boxImageRef: NEXT_REF, controlPlaneOrigin: moved, updateRequested: false }),
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
    assert.equal(
      result.image,
      NEXT_REF,
      `${result.report}\ndocker: ${result.dockerCalls.join(" | ")}\nlog: ${result.log}`,
    );
    // The container env is re-read from the image that is about to run, so a
    // new image's defaults are not shadowed by the old file.
    assert.equal(result.envDefaults, `BLITZ_FROM=${NEXT_REF}\n`);
    assert.equal(plane.reports.length, 1);
    assert.equal(plane.reports[0].authorization, "Bearer box-access-token");
    assert.equal(plane.reports[0].body, JSON.stringify({ ref: NEXT_REF, outcome: "updated" }));
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
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: NEXT_REF, outcome: "pull-failed" }));
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
      assert.equal(
        runs.length,
        2,
        `${result.report}\ndocker: ${result.dockerCalls.join(" | ")}\nlog: ${result.log}`,
      );
      assert.match(runs[0], new RegExp(`${NEXT_REF}$`, "u"));
      assert.match(runs[1], new RegExp(`${RUNNING_REF}$`, "u"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(result.running, "true");
      // Rolling back restores the old image's env file too.
      assert.equal(result.envDefaults, `BLITZ_FROM=${RUNNING_REF}\n`);
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: NEXT_REF, outcome: "rolled-back" }));
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
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: NEXT_REF, outcome: "start-failed" }));
      assert.match(result.log, /rollback failed/u);
      assert.ok(root);
    },
  );
});

test("a requested update to the ref already running clears the flag without pulling", async () => {
  await withHost({}, (planeOrigin) => configFor(RUNNING_REF, planeOrigin), async (root, plane, run) => {
    const result = await run();
    assert.equal(result.status, 0, result.report);
    assert.deepEqual(result.dockerCalls, ["inspect --format {{.Config.Image}} blitz-box"]);
    assert.equal(plane.reports[0].body, JSON.stringify({ ref: RUNNING_REF, outcome: "up-to-date" }));
    assert.ok(root);
  });
});

test("a manifest whose imageTag already runs fetches no parts and reports up-to-date", async () => {
  await withHost(
    { assets: manifestAssets(), runningRef: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${MANIFEST_PATH}`, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      const manifestRef = `${plane.origin}${MANIFEST_PATH}`;
      assert.equal(result.status, 0, result.report);
      assert.deepEqual(plane.assetRequests, [MANIFEST_PATH]);
      assert.deepEqual(result.dockerCalls, ["inspect --format {{.Config.Image}} blitz-box"]);
      assert.equal(result.image, MANIFEST_TAG);
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: manifestRef, outcome: "up-to-date" }));
      assert.ok(root);
    },
  );
});

test("a manifest archive loads and replaces the container by imageTag", async () => {
  await withHost(
    { assets: manifestAssets(), loadedTag: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${MANIFEST_PATH}`, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      const manifestRef = `${plane.origin}${MANIFEST_PATH}`;
      assert.equal(result.status, 0, result.report);
      assert.deepEqual(plane.assetRequests, [
        MANIFEST_PATH,
        "/box-image/release-v2/image.part-00000",
        "/box-image/release-v2/image.part-00001",
      ]);
      assert.ok(result.dockerCalls.includes(`image inspect ${MANIFEST_TAG}`));
      assert.ok(result.dockerCalls.includes("load"));
      assert.ok(
        result.dockerCalls.indexOf("load") < result.dockerCalls.indexOf("rm -f blitz-box"),
        "the manifest image must load before the running container is removed",
      );
      assert.equal(readOptional(path.join(root, "docker-load.input")), `${MANIFEST_TAG}\n`);
      assert.equal(result.image, MANIFEST_TAG);
      assert.equal(result.running, "true");
      assert.equal(result.envDefaults, `BLITZ_FROM=${MANIFEST_TAG}\n`);
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: manifestRef, outcome: "updated" }));
    },
  );
});

test("a manifest part with a bad digest replaces nothing and reports fetch-failed", async () => {
  await withHost(
    { assets: manifestAssets({ badPartSha: true }), loadedTag: MANIFEST_TAG },
    (planeOrigin) => configFor(`${planeOrigin}${MANIFEST_PATH}`, planeOrigin),
    async (root, plane, run) => {
      const result = await run();
      const manifestRef = `${plane.origin}${MANIFEST_PATH}`;
      assert.equal(result.status, 0, result.report);
      assert.deepEqual(plane.assetRequests, [
        MANIFEST_PATH,
        "/box-image/release-v2/image.part-00000",
      ]);
      assert.ok(!result.dockerCalls.includes("load"));
      assert.ok(!result.dockerCalls.includes("rm -f blitz-box"));
      assert.equal(result.image, RUNNING_REF);
      assert.equal(result.running, "true");
      assert.equal(plane.reports[0].body, JSON.stringify({ ref: manifestRef, outcome: "fetch-failed" }));
      assert.ok(root);
    },
  );
});

test("a non-manifest URL reports unsupported and still refreshes the origin", async () => {
  const tarball = "https://cp.example/box-image/image.tar.gz";
  await withHost({}, (planeOrigin) => configFor(tarball, planeOrigin), async (root, plane, run) => {
    const result = await run();
    assert.equal(result.status, 0, result.report);
    assert.ok(!result.dockerCalls.some((call) => call.startsWith("pull")));
    assert.equal(result.image, RUNNING_REF);
    assert.equal(plane.reports[0].body, JSON.stringify({ ref: tarball, outcome: "unsupported" }));
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
