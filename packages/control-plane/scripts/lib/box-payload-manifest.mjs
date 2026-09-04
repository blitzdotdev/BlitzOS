const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PAYLOAD_PATH_PATTERN = /^rootfs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODE_PATTERN = /^0[0-7]{3}$/u;

function record(value, label) {
  if (value === null || Object(value) !== value || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function keysExactly(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function string(value, label) {
  if (String(value) !== value || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveBytes(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function digest(value, label) {
  if (String(value) !== value || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function httpUrl(value, label) {
  string(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
}

function archive(value, label) {
  const object = record(value, label);
  keysExactly(object, ["url", "sha256", "bytes"], label);
  httpUrl(object.url, `${label}.url`);
  digest(object.sha256, `${label}.sha256`);
  positiveBytes(object.bytes, `${label}.bytes`);
}

export function validateBoxPayloadManifest(value, knownServices) {
  const manifest = record(value, "box-payload manifest");
  keysExactly(
    manifest,
    manifest.daemon === undefined
      ? ["version", "createdAt", "minUpdater", "files", "archive", "restart"]
      : ["version", "createdAt", "minUpdater", "files", "archive", "daemon", "restart"],
    "box-payload manifest",
  );
  string(manifest.version, "version");
  if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer timestamp");
  }
  if (!Number.isSafeInteger(manifest.minUpdater) || manifest.minUpdater <= 0) {
    throw new Error("minUpdater must be a positive integer");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("files must be a non-empty array");
  }
  let previousPath = "";
  const payloadPaths = new Set();
  for (const [index, entryValue] of manifest.files.entries()) {
    const entry = record(entryValue, `files[${index}]`);
    keysExactly(entry, ["path", "sha256", "mode"], `files[${index}]`);
    if (String(entry.path) !== entry.path || !PAYLOAD_PATH_PATTERN.test(entry.path)) {
      throw new Error(`files[${index}].path is invalid`);
    }
    if (entry.path <= previousPath) throw new Error("files must be sorted with unique paths");
    previousPath = entry.path;
    payloadPaths.add(entry.path);
    digest(entry.sha256, `files[${index}].sha256`);
    if (String(entry.mode) !== entry.mode || !MODE_PATTERN.test(entry.mode)) {
      throw new Error(`files[${index}].mode is invalid`);
    }
  }
  archive(manifest.archive, "archive");
  if (manifest.daemon !== undefined) {
    const daemon = record(manifest.daemon, "daemon");
    keysExactly(daemon, ["version", "protocolVersion", "url", "sha256", "bytes"], "daemon");
    string(daemon.version, "daemon.version");
    if (!Number.isSafeInteger(daemon.protocolVersion) || daemon.protocolVersion <= 0) {
      throw new Error("daemon.protocolVersion must be a positive integer");
    }
    httpUrl(daemon.url, "daemon.url");
    digest(daemon.sha256, "daemon.sha256");
    positiveBytes(daemon.bytes, "daemon.bytes");
  }
  const restart = record(manifest.restart, "restart");
  for (const [service, paths] of Object.entries(restart)) {
    if (!SERVICE_PATTERN.test(service)) throw new Error(`restart service is invalid: ${service}`);
    if (knownServices !== undefined && !knownServices.has(service)) {
      throw new Error(`restart names unknown service: ${service}`);
    }
    if (!Array.isArray(paths)) throw new Error(`restart.${service} must be an array`);
    let previousDependency = "";
    for (const dependency of paths) {
      if (String(dependency) !== dependency || !payloadPaths.has(dependency)) {
        throw new Error(`restart.${service} names a file outside the payload`);
      }
      if (dependency <= previousDependency) {
        throw new Error(`restart.${service} must be sorted with unique paths`);
      }
      previousDependency = dependency;
    }
  }
  return manifest;
}

