import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { managedFileId } from "./asset-pack.mjs";
import { UPLOAD_ORDER } from "./worker-source.mjs";
import { normalizeSource, sha256 } from "./source-utils.mjs";

export function redactSecrets(value) {
  return String(value)
    .replace(/\btp__[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/(x-project-password\s*:\s*)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/(\/agent\/)[^/\s]+(\/agents\.md)/gu, "$1[REDACTED]$2")
    .replace(/(["'](?:token|agent_link|password)["']\s*:\s*["'])[^"']+/giu, "$1[REDACTED]");
}

export async function projectAccess(probeFile) {
  const probe = JSON.parse(await readFile(probeFile, "utf8"));
  if (typeof probe.slug !== "string" || typeof probe.agent_link !== "string") {
    throw new Error("probe file must contain slug and agent_link");
  }
  const agentUrl = new URL(probe.agent_link);
  const match = /^\/agent\/([^/]+)\/agents\.md$/u.exec(agentUrl.pathname);
  if (agentUrl.origin !== "https://blitz.dev" || match === null) throw new Error("invalid probe agent_link");
  return {
    base: `https://blitz.dev/api/v1/projects/${encodeURIComponent(probe.slug)}`,
    appUrl: `https://${probe.slug}.app.blitz.dev`,
    token: decodeURIComponent(match[1]),
  };
}

export async function managedApiRequest(access, route, init = {}, fetcher = fetch) {
  const response = await fetcher(`${access.base}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access.token}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Text endpoints (including migration previews) are valid responses.
  }
  if (!response.ok) throw new Error(`API ${response.status}: ${redactSecrets(typeof body === "string" ? body : JSON.stringify(body))}`);
  return { response, body };
}

async function managedDataRequest(access, route, init = {}, { allowMissing = false, fetcher = fetch } = {}) {
  const response = await fetcher(`${access.base}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${access.token}`,
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Preserve the managed platform's exact text response for a redacted diagnostic.
  }
  if (allowMissing && response.status === 404) return { response, body: null };
  if (!response.ok) {
    throw new Error(`managed data API ${response.status}: ${redactSecrets(typeof body === "string" ? body : JSON.stringify(body))}`);
  }
  return { response, body };
}

function assertManagedFileRow(row, file) {
  if (
    row === null ||
    typeof row !== "object" ||
    typeof row.object !== "string" ||
    row.object.length === 0 ||
    row.logical_path !== file.logicalPath ||
    row.sha256 !== file.sha256 ||
    row.size_bytes !== file.sizeBytes
  ) {
    throw new Error(`managed file verification failed: ${file.kind} ${file.logicalPath}`);
  }
}

async function readManagedFileRow(access, file, fetcher) {
  const id = managedFileId(file.kind, file.logicalPath);
  const selected = await managedDataRequest(
    access,
    `/exec/blitz_files/view/${encodeURIComponent(id)}`,
    {},
    { allowMissing: true, fetcher },
  );
  return selected.body;
}

async function fileFormData(file, existing) {
  const blob = await openAsBlob(file.sourcePath, { type: file.mediaType });
  const payload = existing === null
    ? {
        values: {
          id: managedFileId(file.kind, file.logicalPath),
          kind: file.kind,
          logical_path: file.logicalPath,
          object: "@filePayload.0",
          media_type: file.mediaType,
          size_bytes: file.sizeBytes,
          sha256: file.sha256,
          release_id: file.releaseId,
          created_at: Date.now(),
        },
        returning: ["id", "object", "sha256"],
      }
    : {
        object: "@filePayload.0",
        media_type: file.mediaType,
        size_bytes: file.sizeBytes,
        sha256: file.sha256,
        release_id: file.releaseId,
      };
  const form = new FormData();
  form.append("@jsonPayload", JSON.stringify(payload));
  form.append("@filePayload", blob, path.basename(file.sourcePath));
  return form;
}

export async function uploadManagedAssets(assetSet, access, projectPassword, { fetcher = fetch } = {}) {
  if (typeof projectPassword !== "string" || projectPassword.length === 0) throw new Error("project password is empty");
  const result = { inserted: 0, replaced: 0, skipped: 0, verified: 0 };
  for (const file of assetSet.files) {
    const existing = await readManagedFileRow(access, file, fetcher);
    if (existing !== null && existing.sha256 === file.sha256 && existing.size_bytes === file.sizeBytes) {
      assertManagedFileRow(existing, file);
      result.skipped += 1;
      result.verified += 1;
      continue;
    }
    const id = managedFileId(file.kind, file.logicalPath);
    const form = await fileFormData(file, existing);
    const route = existing === null
      ? "/exec_write/blitz_files/insert"
      : `/exec_write/blitz_files/edit/${encodeURIComponent(id)}`;
    await managedDataRequest(access, route, {
      method: "POST",
      headers: { "X-Project-Password": projectPassword },
      body: form,
    }, { fetcher });
    const verified = await readManagedFileRow(access, file, fetcher);
    assertManagedFileRow(verified, file);
    if (existing === null) result.inserted += 1;
    else result.replaced += 1;
    result.verified += 1;
  }
  return result;
}

export function saveVersion(response, body) {
  const header = response.headers.get("x-save-version") ?? response.headers.get("etag")?.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const resultVersion = typeof body === "object" && body !== null && typeof body.result?.version === "number"
    ? String(body.result.version)
    : undefined;
  return resultVersion ?? header;
}

export function migrationText(body) {
  if (typeof body === "string") return body;
  const candidates = [body?.result?.content, body?.result?.text, body?.result?.sql, body?.content, body?.text, body?.sql];
  const value = candidates.find((candidate) => typeof candidate === "string");
  if (value === undefined) throw new Error("migration response did not contain SQL text");
  return value;
}

export async function uploadManagedSet(uploadSet, probeFile, { commit = false } = {}) {
  const access = await projectAccess(probeFile);
  await managedApiRequest(access, "/vars/APP_URL", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: access.appUrl }),
  });
  const listed = await managedApiRequest(access, "/files");
  let version = saveVersion(listed.response, listed.body);
  if (version === undefined) throw new Error("file listing omitted x-save-version");
  const byPath = new Map(uploadSet.files.map((file) => [file.path, file]));
  const saves = [];
  const started = performance.now();

  for (const uploadPath of UPLOAD_ORDER) {
    const file = byPath.get(uploadPath);
    if (file === undefined) throw new Error(`upload set omitted ${uploadPath}`);
    const saveStarted = performance.now();
    const saved = await managedApiRequest(access, `/files?path=${encodeURIComponent(file.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": version },
      body: file.source,
    });
    if (typeof saved.body !== "object" || saved.body === null || saved.body.success !== true) {
      throw new Error(`save failed for ${file.path}: ${redactSecrets(JSON.stringify(saved.body))}`);
    }
    const result = saved.body.result;
    if (result?.config?.ok !== true || result?.bundle?.ok !== true) {
      throw new Error(`build failed for ${file.path}: ${redactSecrets(JSON.stringify({ config: result?.config, bundle: result?.bundle }))}`);
    }
    const nextVersion = saveVersion(saved.response, saved.body);
    if (nextVersion === undefined) throw new Error(`save response omitted version for ${file.path}`);
    version = nextVersion;
    saves.push({ path: file.path, configOk: true, bundleOk: true, durationMs: Math.round(performance.now() - saveStarted) });
    process.stdout.write(`saved\t${file.path}\tconfig.ok\tbundle.ok\t${saves.at(-1).durationMs}ms\n`);
  }

  const migrationResponse = await managedApiRequest(access, "/files?path=%40migration.sql");
  const migration = normalizeSource(migrationText(migrationResponse.body));
  process.stdout.write(`migration-schema-sha256\t${byPath.get("teenybase.ts").sha256}\n`);
  process.stdout.write(`migration-sql-sha256\t${sha256(migration)}\n`);
  process.stdout.write(migration);

  if (commit) {
    const committed = await managedApiRequest(access, "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `blitz-core managed release ${uploadSet.releaseHash}` }),
    });
    if (typeof committed.body !== "object" || committed.body === null || committed.body.success !== true) {
      throw new Error(`commit failed: ${redactSecrets(JSON.stringify(committed.body))}`);
    }
  }

  return {
    saves,
    durationMs: Math.round(performance.now() - started),
    migration,
    migrationSha256: sha256(migration),
    committed: commit,
  };
}
