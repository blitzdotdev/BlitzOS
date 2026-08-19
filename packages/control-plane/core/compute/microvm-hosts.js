// @ts-check
/* oxlint-disable anti-slop/no-runtime-typeof -- This portable JSON boundary must validate primitive types before it can return named host configs. */

export const MICROVM_HOST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOKEN_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

/**
 * @typedef {object} StaticMicrovmHostConfig
 * @property {string} name
 * @property {string} url
 * @property {string} tokenVar
 */

/**
 * @typedef {object} DynamicMicrovmHostConfig
 * @property {string} name
 * @property {string} tokenVar
 * @property {true} dynamic
 */

/** @typedef {StaticMicrovmHostConfig | DynamicMicrovmHostConfig} MicrovmHostConfig */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} expected
 * @param {string} description
 */
function exactFields(value, expected, description) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    throw new Error(`invalid ${description} fields`);
  }
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeMicrovmHostUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MICROVM_HOSTS url must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "MICROVM_HOSTS url must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

/**
 * Parse the MICROVM_HOSTS environment/config value used by both deploy and runtime.
 *
 * @param {unknown} rawHosts
 * @returns {MicrovmHostConfig[]}
 */
export function parseMicrovmHosts(rawHosts) {
  if (typeof rawHosts !== "string") {
    throw new Error("MICROVM_HOSTS must be a JSON array");
  }
  let hosts;
  try {
    hosts = JSON.parse(rawHosts);
  } catch {
    throw new Error("MICROVM_HOSTS must be valid JSON");
  }
  if (!Array.isArray(hosts)) throw new Error("MICROVM_HOSTS must be a JSON array");

  const names = new Set();
  const urls = new Set();
  return hosts.map((host, index) => {
    if (!isRecord(host)) {
      throw new Error(`MICROVM_HOSTS[${index}] must be an object`);
    }
    const dynamic = host.dynamic === true;
    exactFields(
      host,
      dynamic ? ["name", "tokenVar", "dynamic"] : ["name", "url", "tokenVar"],
      `MICROVM_HOSTS[${index}]`,
    );

    const name = host.name;
    if (typeof name !== "string" || !MICROVM_HOST_NAME_PATTERN.test(name)) {
      throw new Error(`MICROVM_HOSTS[${index}].name is invalid`);
    }
    if (names.has(name)) {
      throw new Error(`MICROVM_HOSTS contains duplicate name ${name}`);
    }
    names.add(name);

    const tokenVar = host.tokenVar;
    if (typeof tokenVar !== "string" || !TOKEN_VAR_PATTERN.test(tokenVar)) {
      throw new Error(`MICROVM_HOSTS[${index}].tokenVar is invalid`);
    }
    if (tokenVar === "MICROVM_HOSTS") {
      throw new Error(
        `MICROVM_HOSTS[${index}].tokenVar must name a secret binding`,
      );
    }
    if (dynamic) return { name, tokenVar, dynamic: true };

    if (typeof host.url !== "string") {
      throw new Error(`MICROVM_HOSTS[${index}].url must be a string`);
    }
    const url = normalizeMicrovmHostUrl(host.url);
    if (urls.has(url)) {
      throw new Error(`MICROVM_HOSTS contains duplicate url ${url}`);
    }
    urls.add(url);
    return { name, url, tokenVar };
  });
}
