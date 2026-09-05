import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBootstrapScript } from "../dist/core/bootstrap.js";
import { AwsProvider } from "../dist/core/compute/aws.js";

// Text pins prove what the emitter writes. They cannot prove what bash does
// with it, and the incident was a shell-semantics fault: `set -Eeuo pipefail`
// plus a command substitution from a grep that matched nothing. So this suite
// runs the emitted apt setup in real bash. See plans/PROVIDER-BOOTSTRAP.md.

const BOOTSTRAP_BASE = {
  boxImageSha256: "",
  boxImageRef: "ghcr.io/blitzdotdev/blitz-box:test",
  boxImageTag: "",
  phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
  sshPublicKey: "ssh-ed25519 AAAAcaller",
};

const AWS_APT_SETUP = new AwsProvider({
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
}).bootstrapAptSetup();

const EC2_MIRROR = "http://us-east-1.ec2.archive.ubuntu.com";
const FALLBACK_MIRROR = "http://archive.ubuntu.com";

/** The emitted apt setup, ready to run: the real shebang and shell options,
 * then everything from the apt tuning up to the docker-presence guard that
 * wraps the first `apt_watchdog` call. The run stops at that guard, because
 * installing docker.io needs a real box. `/etc/apt` is repointed at a scratch
 * directory so a test never reads or writes the machine's own apt sources. */
function runnableAptSetup(providerAptSetup, aptRoot, extraLines = "") {
  const script = providerAptSetup === undefined
    ? buildBootstrapScript(BOOTSTRAP_BASE)
    : buildBootstrapScript({ ...BOOTSTRAP_BASE, providerAptSetup });
  const lines = script.split("\n");
  const start = lines.indexOf("export DEBIAN_FRONTEND=noninteractive");
  // The guard is the boundary: slicing at `apt_watchdog update` itself would
  // cut the enclosing `if` in half and hand bash an unbalanced block.
  const end = lines.findIndex((line) => line.startsWith("if command -v docker "));
  assert.ok(start > 0, "apt setup start was not found in the emitted script");
  assert.ok(end > start, "docker-presence guard was not found in the emitted script");
  const header = lines.slice(0, 2).join("\n");
  assert.equal(header, "#!/bin/bash\nset -Eeuo pipefail");
  const section = lines.slice(start, end).join("\n");
  return `${header}\n${section.replaceAll("/etc/apt", `${aptRoot}/etc/apt`)}\n${extraLines}`;
}

/** The emitted inotify setup, repointed at a scratch `/etc/sysctl.d`. A
 * refusing `sysctl` stand-in proves that applying the file remains non-fatal
 * without changing the machine that runs the test. */
function runnableInotifySetup(root) {
  const lines = buildBootstrapScript(BOOTSTRAP_BASE).split("\n");
  const start = lines.indexOf("cat >/etc/sysctl.d/60-blitz-inotify.conf <<'INOTIFY'");
  const end = lines.indexOf("systemctl enable --now docker");
  assert.ok(start > 0, "inotify setup start was not found in the emitted script");
  assert.ok(end > start, "Docker start was not found after the inotify setup");
  const header = lines.slice(0, 2).join("\n");
  assert.equal(header, "#!/bin/bash\nset -Eeuo pipefail");
  const section = lines.slice(start, end).join("\n");
  const sysctlRoot = path.join(root, "etc/sysctl.d");
  return `${header}\nblitz_phase() { :; }\n${section.replaceAll("/etc/sysctl.d", sysctlRoot)}\n`;
}

/** A scratch apt tree plus a curl that answers without a network. `curlStatus`
 * is what the mirror probe sees: 0 for a mirror that answers, 22 for curl's
 * own "HTTP error" status on one that does not. */
function scratchBox(sources, curlStatus) {
  const root = mkdtempSync(path.join(tmpdir(), "blitz-bootstrap-bash-"));
  mkdirSync(path.join(root, "etc/apt/apt.conf.d"), { recursive: true });
  mkdirSync(path.join(root, "etc/apt/sources.list.d"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "etc/apt/sources.list"), "# deb822 sources live in sources.list.d\n");
  for (const [name, content] of Object.entries(sources)) {
    writeFileSync(path.join(root, "etc/apt/sources.list.d", name), content);
  }
  const curl = path.join(root, "bin/curl");
  writeFileSync(
    curl,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${root}/curl.argv"\nexit ${curlStatus}\n`,
  );
  chmodSync(curl, 0o755);
  return root;
}

/** Runs the section under `bash -x`. A boot that dies under `set -e` prints
 * nothing of its own, so the trace names the command that killed it. */
function runBash(script, root) {
  const scriptPath = path.join(root, "apt-setup.sh");
  writeFileSync(scriptPath, script);
  const result = spawnSync("bash", ["-x", scriptPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}` },
  });
  const trace = (result.stderr ?? "").trimEnd().split("\n").slice(-3).join("\n");
  return { status: result.status, report: `bash exited ${result.status}; last trace:\n${trace}` };
}

function ubuntuSources(mirror) {
  return `Types: deb\nURIs: ${mirror}/ubuntu\nSuites: noble noble-updates\nComponents: main universe\n`;
}

test("manifest parts stay beneath a versioned box-image release prefix", () => {
  const releaseId = "0123456789abcdef".repeat(4);
  const bootstrap = buildBootstrapScript({
    ...BOOTSTRAP_BASE,
    boxImageRef: `https://cp.example/box-image/${releaseId}/manifest.json`,
    boxImageTag: `blitz-box:${releaseId}`,
    boxImageSha256: "a".repeat(64),
  });
  // A versioned manifest owns parts under its release directory, so deriving
  // the base from the complete ref must preserve box-image/<releaseId>/.
  assert.ok(bootstrap.includes('manifest_base=${BOX_IMAGE_REF%/*}'));
  assert.ok(bootstrap.includes('download "$manifest_base/$part_name" "$part_path"'));
});

test("the emitted inotify setup writes both limits in real bash", () => {
  const root = mkdtempSync(path.join(tmpdir(), "blitz-bootstrap-inotify-"));
  try {
    mkdirSync(path.join(root, "etc/sysctl.d"), { recursive: true });
    mkdirSync(path.join(root, "bin"));
    const sysctl = path.join(root, "bin/sysctl");
    writeFileSync(sysctl, "#!/bin/sh\nexit 1\n");
    chmodSync(sysctl, 0o755);
    const result = runBash(runnableInotifySetup(root), root);
    assert.equal(result.status, 0, result.report);
    assert.equal(
      readFileSync(path.join(root, "etc/sysctl.d/60-blitz-inotify.conf"), "utf8"),
      "fs.inotify.max_user_instances = 1024\nfs.inotify.max_user_watches = 524288\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The box runs Ubuntu, so the emitted `sed -i -E` is GNU sed. BSD sed reads
 * `-i -E` as an edit-in-place suffix and changes nothing. Exit statuses stay
 * under test everywhere; only the rewritten bytes need the real tool. */
const gnuSed = spawnSync("sed", ["--version"], { encoding: "utf8" }).status === 0;

test("a box whose provider contributes nothing runs the apt setup to the end", () => {
  const root = scratchBox({ "ubuntu.sources": ubuntuSources(FALLBACK_MIRROR) }, 0);
  try {
    // The watchdog calls apt_mirror_fallback between attempts. Call it here:
    // an undefined function exits 127, which set -e turns into a dead boot.
    const result = runBash(runnableAptSetup(undefined, root, "apt_mirror_fallback\n"), root);
    assert.equal(result.status, 0, result.report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the AWS apt setup survives a box that has no EC2 mirror", () => {
  const root = scratchBox({ "ubuntu.sources": ubuntuSources(FALLBACK_MIRROR) }, 0);
  try {
    const result = runBash(runnableAptSetup(AWS_APT_SETUP, root), root);
    assert.equal(result.status, 0, result.report);
    // grep matched nothing, so the probe never ran.
    assert.equal(existsSync(path.join(root, "curl.argv")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the AWS apt setup leaves an EC2 mirror that does not answer", () => {
  const root = scratchBox({ "ubuntu.sources": ubuntuSources(EC2_MIRROR) }, 22);
  try {
    const result = runBash(runnableAptSetup(AWS_APT_SETUP, root), root);
    assert.equal(result.status, 0, result.report);
    assert.match(
      readFileSync(path.join(root, "curl.argv"), "utf8"),
      /us-east-1\.ec2\.archive\.ubuntu\.com\/ubuntu\/dists\/noble\/InRelease/u,
    );
    if (gnuSed) {
      const rewritten = readFileSync(path.join(root, "etc/apt/sources.list.d/ubuntu.sources"), "utf8");
      assert.equal(rewritten, ubuntuSources(FALLBACK_MIRROR));
    } else {
      console.warn("SKIP: GNU sed is missing, so the rewritten sources were not checked");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the AWS apt setup keeps an EC2 mirror that answers", () => {
  const root = scratchBox({ "ubuntu.sources": ubuntuSources(EC2_MIRROR) }, 0);
  try {
    const result = runBash(runnableAptSetup(AWS_APT_SETUP, root), root);
    assert.equal(result.status, 0, result.report);
    const kept = readFileSync(path.join(root, "etc/apt/sources.list.d/ubuntu.sources"), "utf8");
    assert.equal(kept, ubuntuSources(EC2_MIRROR));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
