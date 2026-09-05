#!/usr/bin/env node

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageBoxPayloadRelease } from "../../control-plane/scripts/publish-box-payload.mjs";

const [repoRoot, variant, binariesDirectory, outputDirectory, origin] = process.argv.slice(2);
if (
  repoRoot === undefined
  || !["E17", "E18", "E19"].includes(variant)
  || binariesDirectory === undefined
  || outputDirectory === undefined
  || origin === undefined
) {
  throw new Error(
    "usage: payload-live-release.mjs <repo-root> <E17|E18|E19> <binaries> <output> <origin>",
  );
}

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "blitz-smoke-payload-repo-"));
try {
  const rootfs = path.join(fixtureRoot, "packages/box/rootfs");
  await mkdir(path.dirname(rootfs), { recursive: true });
  await cp(path.join(repoRoot, "packages/box/rootfs"), rootfs, { recursive: true });
  const services = path.join(rootfs, "etc/s6-overlay/s6-rc.d");
  if (variant === "E17") {
    await mkdir(path.join(services, "hello"), { recursive: true });
    await writeFile(path.join(services, "hello/type"), "longrun\n");
    await writeFile(
      path.join(services, "hello/run"),
      "#!/command/with-contenv sh\nexec sleep infinity\n",
      { mode: 0o755 },
    );
    await writeFile(path.join(services, "user/contents.d/hello"), "");
  } else if (variant === "E19") {
    await rm(path.join(services, "payload"), { recursive: true, force: true });
  }
  const stagingDirectory = path.join(fixtureRoot, "staging");
  const staged = await stageBoxPayloadRelease({
    repoRoot: fixtureRoot,
    stagingDirectory,
    outputDirectory,
    binariesDirectory,
    createdAt: 1_788_550_000_000,
    appUrl: origin,
  });
  process.stdout.write(`${JSON.stringify({ version: staged.version })}\n`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
