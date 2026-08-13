import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");

export async function cleanDist(packageRoot = packageDirectory) {
  await rm(path.join(path.resolve(packageRoot), "dist"), {
    recursive: true,
    force: true,
  });
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedUrl === import.meta.url) {
  await cleanDist();
}
