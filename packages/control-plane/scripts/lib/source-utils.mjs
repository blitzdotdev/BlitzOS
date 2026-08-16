import { createHash } from "node:crypto";

export function normalizeSource(source) {
  return source.replace(/\r\n?/gu, "\n").replace(/\s+$/u, "") + "\n";
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

