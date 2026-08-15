export const CONFIG_PATH = "packages/control-plane/wrangler.toml";
export const DB_BINDING = "DB";
export const REQUIRED_SECRETS = Object.freeze([
  "HETZNER_API_TOKEN",
  "OPERATOR_API_KEY",
  "CRED_MASTER_KEY",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value, expected, description) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`invalid ${description} fields`);
  }
}

function normalizedMicrovmHostUrl(raw) {
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

function parseMicrovmHosts(rawHosts) {
  if (rawHosts === undefined || rawHosts === "") return [];
  if (typeof rawHosts !== "string") throw new Error("MICROVM_HOSTS must be a JSON array");
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
    if (!isRecord(host)) throw new Error(`MICROVM_HOSTS[${index}] must be an object`);
    const dynamic = host.dynamic === true;
    exactFields(
      host,
      dynamic ? ["name", "tokenVar", "dynamic"] : ["name", "url", "tokenVar"],
      `MICROVM_HOSTS[${index}]`,
    );
    if (
      typeof host.name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host.name)
    ) {
      throw new Error(`MICROVM_HOSTS[${index}].name is invalid`);
    }
    if (names.has(host.name)) {
      throw new Error(`MICROVM_HOSTS contains duplicate name ${host.name}`);
    }
    names.add(host.name);
    if (
      typeof host.tokenVar !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(host.tokenVar)
    ) {
      throw new Error(`MICROVM_HOSTS[${index}].tokenVar is invalid`);
    }
    if (host.tokenVar === "MICROVM_HOSTS") {
      throw new Error(`MICROVM_HOSTS[${index}].tokenVar must name a secret binding`);
    }
    if (dynamic) return { name: host.name, tokenVar: host.tokenVar, dynamic: true };
    if (typeof host.url !== "string") {
      throw new Error(`MICROVM_HOSTS[${index}].url must be a string`);
    }
    const url = normalizedMicrovmHostUrl(host.url);
    if (urls.has(url)) throw new Error(`MICROVM_HOSTS contains duplicate url ${url}`);
    urls.add(url);
    return { name: host.name, url, tokenVar: host.tokenVar };
  });
}

export function parseD1Binding(rawConfig, binding) {
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.d1_databases)) {
    throw new Error("wrangler config must define d1_databases");
  }
  const matches = rawConfig.d1_databases.filter(
    (database) => isRecord(database) && database.binding === binding,
  );
  if (matches.length !== 1) {
    throw new Error(`wrangler config must define exactly one ${binding} D1 binding`);
  }
  const database = matches[0];
  if (typeof database.database_name !== "string" || database.database_name === "") {
    throw new Error(`${binding} must define database_name`);
  }
  return {
    binding,
    databaseName: database.database_name,
    databaseId:
      typeof database.database_id === "string" ? database.database_id : null,
  };
}

export function d1DatabasePatch(rawConfig, binding, databaseName, databaseId) {
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.d1_databases)) {
    throw new Error("wrangler config must define d1_databases");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(databaseId)) {
    throw new Error(`Cloudflare returned an invalid D1 database UUID for ${databaseName}`);
  }
  let replacements = 0;
  const d1Databases = rawConfig.d1_databases.map((database) => {
    if (!isRecord(database) || database.binding !== binding) return database;
    replacements += 1;
    if (database.database_name !== databaseName) {
      throw new Error(`${binding} database_name changed while preparing deployment`);
    }
    return { ...database, database_id: databaseId };
  });
  if (replacements !== 1) {
    throw new Error(`wrangler config must define exactly one ${binding} D1 binding`);
  }
  return { d1_databases: d1Databases };
}

function parseJson(stdout, description) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${description} did not return valid JSON`);
  }
}

function findDatabase(databases, databaseName) {
  if (!Array.isArray(databases)) throw new Error("Wrangler D1 list was not an array");
  const matches = databases.filter(
    (database) => isRecord(database) && database.name === databaseName,
  );
  if (matches.length > 1) {
    throw new Error(`multiple D1 databases are named ${databaseName}`);
  }
  const database = matches[0];
  if (database === undefined) return null;
  if (typeof database.uuid !== "string") {
    throw new Error(`D1 database ${databaseName} has no UUID`);
  }
  return database.uuid;
}

function secretNames(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler secret list was not an array");
  return new Set(
    value.flatMap((secret) =>
      isRecord(secret) && typeof secret.name === "string" ? [secret.name] : [],
    ),
  );
}

export function requiredSecretsForConfig(rawConfig) {
  const rawHosts = isRecord(rawConfig?.vars) ? rawConfig.vars.MICROVM_HOSTS : undefined;
  const tokenVars = parseMicrovmHosts(rawHosts).map((host) => host.tokenVar);
  return [...new Set([...REQUIRED_SECRETS, ...tokenVars])];
}

export function missingSecretsMessage(missing) {
  const commands = missing.map(
    (name) => `npx wrangler secret put ${name} --config ${CONFIG_PATH}`,
  );
  return `Missing required Worker secrets: ${missing.join(", ")}\nSet them with:\n${commands.join("\n")}\nThen rerun: npm run deploy -w packages/control-plane`;
}

export async function deployControlPlane({
  configPath = CONFIG_PATH,
  rawConfig,
  run,
  patchConfig,
} = {}) {
  if (!isRecord(rawConfig)) throw new Error("raw Wrangler config is required");
  if (typeof run !== "function") throw new Error("deploy command runner is required");
  if (typeof patchConfig !== "function") throw new Error("Wrangler config patcher is required");
  const databaseBinding = parseD1Binding(rawConfig, DB_BINDING);
  const commandEnv = {
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  const invoke = (tool, args, capture = false) =>
    run(tool, args, { capture, env: commandEnv });
  const wrangler = (args, capture = false) =>
    invoke("wrangler", [...args, "--config", configPath], capture);

  const whoami = await wrangler(["whoami", "--json"], true);
  parseJson(whoami.stdout, "Wrangler authentication check");

  let listed = await wrangler(["d1", "list", "--json"], true);
  let databaseId = findDatabase(
    parseJson(listed.stdout, "Wrangler D1 list"),
    databaseBinding.databaseName,
  );
  if (databaseId === null) {
    await wrangler(["d1", "create", databaseBinding.databaseName], true);
    listed = await wrangler(["d1", "list", "--json"], true);
    databaseId = findDatabase(
      parseJson(listed.stdout, "Wrangler D1 list after create"),
      databaseBinding.databaseName,
    );
    if (databaseId === null) {
      throw new Error(`D1 database ${databaseBinding.databaseName} was not visible after create`);
    }
  }

  if (databaseBinding.databaseId !== databaseId) {
    await patchConfig(
      d1DatabasePatch(
        rawConfig,
        DB_BINDING,
        databaseBinding.databaseName,
        databaseId,
      ),
    );
  }

  await wrangler(["d1", "migrations", "apply", DB_BINDING, "--remote"]);

  let secrets;
  try {
    secrets = await wrangler(["secret", "list", "--format", "json"], true);
  } catch {
    throw new Error(missingSecretsMessage(REQUIRED_SECRETS));
  }
  const present = secretNames(parseJson(secrets.stdout, "Wrangler secret list"));
  const missing = requiredSecretsForConfig(rawConfig).filter((name) => !present.has(name));
  if (missing.length > 0) throw new Error(missingSecretsMessage(missing));

  await invoke("npm", ["run", "build", "-w", "@blitzos/ui"]);
  await wrangler(["deploy"]);
}
