import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export async function createDeterministicTarGzip(sourceDirectory, outputPath, entries) {
  const child = spawn("tar", [
    "--sort=name",
    "--format=gnu",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-cf",
    "-",
    "-C",
    sourceDirectory,
    ...entries,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece) => {
    stderr += piece;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await pipeline(
    child.stdout,
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(outputPath, { mode: 0o644 }),
  );
  const { code, signal } = await exit;
  if (code !== 0) {
    const reason = signal === null ? `exit ${code}` : `signal ${signal}`;
    throw new Error(`tar failed (${reason})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
  }
}

export async function hashFile(filePath) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}
