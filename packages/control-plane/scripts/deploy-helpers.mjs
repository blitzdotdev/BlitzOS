import {
  allowedEmailDomainsFromEnv,
  cloudWorkspaceCredentialPolicyFromEnv,
  signupModeFromEnv,
} from "../core/signup-config.js";
import { deriveRunWorkerFirst } from "./lib/worker-first-routes.mjs";

export const CONFIG_PATH = "packages/control-plane/wrangler.toml";
export const DB_BINDING = "DB";
export const R2_BINDING = "BOX_IMAGES";
// Secrets every deployment needs. OPERATOR_API_KEY is intentionally absent:
// it is a legacy operator credential — optional, only for old operator-key
// flows — so the deploy no longer demands it.
export const REQUIRED_SECRETS = Object.freeze([
  "HETZNER_API_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "WEBAPP_TOKEN_SECRET",
  "CRED_MASTER_KEY",
]);

// Angle-bracket text is documentation shorthand ("<your zone id>"), never a
// value. The template ships none — vars that can only be filled in after a
// first deploy ship as "" — so this only catches an operator who pasted a
// doc example into wrangler.toml.
export const PLACEHOLDER_VALUE_PATTERN = /^<[^<>]*>$/u;
// R2 bucket names: 3-63 chars of lowercase letters, digits, and hyphens.
const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
// The canonical base64 alphabet accepted by the Worker's atob-based decoder.
const STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * True when the config already carries an assets.run_worker_first array.
 *
 * @param {unknown} rawConfig parsed wrangler config
 * @returns {boolean}
 */
export function hasRunWorkerFirst(rawConfig) {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.assets)) return false;
  return Array.isArray(rawConfig.assets.run_worker_first);
}

/**
 * The patch that removes assets.run_worker_first.
 *
 * It has to be a separate step. wrangler's experimental_patchConfig writes an
 * array element by element and leaves whatever sat past the end of the new one
 * in place, so writing a shorter list over a longer one keeps the old tail —
 * exactly the stale entries this generator exists to retire. Deleting the key
 * first turns the write into a replacement. Only call it when
 * hasRunWorkerFirst is true: deleting a key that is not there throws.
 *
 * @returns {object} a wrangler config patch
 */
export function runWorkerFirstRemoval() {
  return { assets: { run_worker_first: undefined } };
}

/**
 * The patch that writes the derived route list into a wrangler config.
 *
 * @param {readonly string[]} entries derived run_worker_first entries
 * @returns {object} a wrangler config patch
 */
export function runWorkerFirstPatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("refusing to write an empty assets.run_worker_first: every core route would be served the SPA shell");
  }
  return { assets: { run_worker_first: [...entries] } };
}

export function parseR2Binding(rawConfig, binding) {
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.r2_buckets)) {
    throw new Error("wrangler config must define r2_buckets");
  }
  const matches = rawConfig.r2_buckets.filter(
    (bucket) => isRecord(bucket) && bucket.binding === binding,
  );
  if (matches.length !== 1) {
    throw new Error(`wrangler config must define exactly one ${binding} R2 binding`);
  }
  const bucketName = String(matches[0].bucket_name);
  if (!R2_BUCKET_NAME_PATTERN.test(bucketName)) {
    throw new Error(`${binding} must define a valid bucket_name`);
  }
  return { binding, bucketName };
}

// `wrangler r2 bucket list` has no --json flag; it prints labelled values
// ("name:  <bucket>" lines). Wrangler is version-pinned, so parse those.
export function r2BucketNamesFromList(output) {
  const names = new Set();
  for (const line of String(output).split("\n")) {
    const match = /^name:\s*(\S+)$/u.exec(line.trim());
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

// `wrangler r2 bucket list` is the one step of the deploy that does not read
// account_id out of the config file, so a login that can see several accounts
// stops there with "More than one account available but unable to select one
// in non-interactive mode". Passing the configured account through the
// environment variable wrangler names in that error scopes every call alike.
export function configuredAccountId(rawConfig) {
  if (!isRecord(rawConfig)) return null;
  const accountId = String(rawConfig.account_id ?? "").trim();
  return accountId === "" ? null : accountId;
}

export function placeholderVars(rawConfig) {
  const vars = isRecord(rawConfig) && isRecord(rawConfig.vars) ? rawConfig.vars : {};
  return Object.keys(vars).filter((name) =>
    PLACEHOLDER_VALUE_PATTERN.test(String(vars[name])),
  );
}

// These vars are parsed per request by the Worker. A typo turns every request
// and cron into a 500, so reject it before deploy with the same parser.
export function configVarProblems(rawConfig) {
  const vars = isRecord(rawConfig) && isRecord(rawConfig.vars) ? rawConfig.vars : {};
  const problems = [];
  for (const [name, parse] of [
    ["SIGNUP_MODE", signupModeFromEnv],
    ["ALLOWED_EMAIL_DOMAINS", allowedEmailDomainsFromEnv],
    ["CLOUD_WORKSPACE_CREDENTIAL_POLICY", cloudWorkspaceCredentialPolicyFromEnv],
  ]) {
    const value = vars[name];
    if (value === undefined) continue;
    try {
      parse(String(value));
    } catch (error) {
      problems.push(
        `${name} = ${JSON.stringify(String(value))} is invalid: ${error instanceof Error ? error.message : "unparseable"} — the Worker parses it on every request, so deploying this value would 500 the whole deployment`,
      );
    }
  }
  return problems;
}

// Validates the secret values that are readable at deploy time (the local
// process environment). Values already stored in Cloudflare cannot be read
// back, so an unset local variable is skipped silently — the presence check
// against `wrangler secret list` still applies to every required name.
export function localSecretValueProblems(rawConfig, secretValues) {
  const problems = [];
  const masterKey = secretValues.CRED_MASTER_KEY;
  if (
    masterKey !== undefined &&
    !(
      STANDARD_BASE64_PATTERN.test(String(masterKey)) &&
      Buffer.from(String(masterKey), "base64").byteLength === 32
    )
  ) {
    problems.push(
      "CRED_MASTER_KEY must be base64 of exactly 32 bytes (generate one with: openssl rand -base64 32)",
    );
  }
  return problems;
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

export function requiredSecretsForConfig(_rawConfig) {
  return [...REQUIRED_SECRETS];
}

// Wrangler prints the actionable half of a failure on stderr, and the deploy
// captures stderr for every command it parses output from. Dropping it left
// real errors reading only "<command> failed with exit 1".
export function commandFailureMessage(tool, args, reason, stderr = "") {
  const command = `${tool} ${args.join(" ")}`;
  const detail = String(stderr).trim();
  return detail === ""
    ? `${command} failed with ${reason}`
    : `${command} failed with ${reason}\n${detail}`;
}

export function missingSecretsMessage(missing) {
  const commands = missing.map(
    (name) => `npx wrangler secret put ${name} --config ${CONFIG_PATH}`,
  );
  return `Missing required Worker secrets: ${missing.join(", ")}\nSet them with:\n${commands.join("\n")}\nThen rerun: npm run deploy -w packages/control-plane`;
}

/** Wrangler vars supplied by the deploying environment rather than by config.
 *
 * A setting that differs per deployment and is not secret belongs in neither
 * the committed example nor the stored wrangler.toml: the example is one value
 * for everyone, and the stored config is repaired from it on every deploy. The
 * hosted workflows export BLITZ_DEPLOY_VAR_<NAME>; a self-hoster exports none
 * and keeps every example default.
 *
 * An empty value is not a value. A workflow reads these from GitHub secrets or
 * variables, and an unset one arrives as the empty string, so skipping it is
 * what lets a workflow name a setting before anyone has decided it. */
export function overrideVarsFromEnvironment(environment) {
  const prefix = "BLITZ_DEPLOY_VAR_";
  const vars = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith(prefix) || value === undefined || value === "") continue;
    vars[key.slice(prefix.length)] = value;
  }
  return vars;
}

export async function deployControlPlane({
  configPath = CONFIG_PATH,
  rawConfig,
  run,
  patchConfig,
  secretValues = process.env,
  gitCommitSha = "",
  overrideVars = {},
  runWorkerFirst = deriveRunWorkerFirst,
} = {}) {
  if (!isRecord(rawConfig)) throw new Error("raw Wrangler config is required");
  if (typeof run !== "function") throw new Error("deploy command runner is required");
  if (typeof patchConfig !== "function") throw new Error("Wrangler config patcher is required");
  const databaseBinding = parseD1Binding(rawConfig, DB_BINDING);
  const bucketBinding = parseR2Binding(rawConfig, R2_BINDING);
  const placeholders = placeholderVars(rawConfig);
  if (placeholders.length > 0) {
    throw new Error(
      `${configPath} still holds template placeholder values for: ${placeholders.join(", ")}\nEdit the file (start from wrangler.toml.example) and rerun the deploy.`,
    );
  }
  const varProblems = configVarProblems(rawConfig);
  if (varProblems.length > 0) {
    throw new Error(varProblems.join("\n"));
  }
  const secretProblems = localSecretValueProblems(rawConfig, secretValues);
  if (secretProblems.length > 0) {
    throw new Error(secretProblems.join("\n"));
  }
  const commandEnv = {
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  const accountId = configuredAccountId(rawConfig);
  if (accountId !== null) commandEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
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

  // Name what is about to change before it changes. The apply below is
  // silent about scope, and a deployment many versions behind can carry a
  // migration nobody remembers writing.
  try {
    console.log("Pending D1 migrations:");
    await wrangler(["d1", "migrations", "list", DB_BINDING, "--remote"]);
  } catch {
    // A preview is not a gate. Wrangler versions differ on this subcommand,
    // and failing the deploy over a listing would be worse than not knowing.
    console.log("  (could not list migrations; the apply below still runs)");
  }
  await wrangler(["d1", "migrations", "apply", DB_BINDING, "--remote"]);

  const listedBuckets = await wrangler(["r2", "bucket", "list"], true);
  if (!r2BucketNamesFromList(listedBuckets.stdout).has(bucketBinding.bucketName)) {
    await wrangler(["r2", "bucket", "create", bucketBinding.bucketName], true);
  }

  let secrets;
  try {
    secrets = await wrangler(["secret", "list", "--format", "json"], true);
  } catch {
    throw new Error(missingSecretsMessage(REQUIRED_SECRETS));
  }
  const present = secretNames(parseJson(secrets.stdout, "Wrangler secret list"));
  const missing = requiredSecretsForConfig(rawConfig).filter((name) => !present.has(name));
  if (missing.length > 0) throw new Error(missingSecretsMessage(missing));

  await invoke("npm", ["run", "build", "-w", "@blitzos/webapp"]);

  // Which paths the Worker must answer instead of the asset server is derived
  // from core's route registrations and written in here, immediately before the
  // deploy. It used to be hand-maintained inside the CANARY_WRANGLER_TOML and
  // PROD_WRANGLER_TOML secrets, which meant a human had to edit two stored
  // configs for every new route; twice nobody did, and the route shipped
  // answering the SPA shell with status 200. Whatever the stored config holds
  // is overwritten, so it never has to be edited for a route again.
  const workerFirstEntries = runWorkerFirst();
  if (hasRunWorkerFirst(rawConfig)) await patchConfig(runWorkerFirstRemoval());
  await patchConfig(runWorkerFirstPatch(workerFirstEntries));
  console.log(
    `assets.run_worker_first: wrote ${workerFirstEntries.length} derived entries into ${configPath}`,
  );

  // --var overrides one key and leaves every other var from the config in
  // place. The values travel with the Worker version, so a rollback restores
  // them along with the old code.
  //
  // overrideVars carries settings that differ per deployment but are not
  // secret, so they belong in neither the committed example nor the stored
  // config. The two hosted deployments set them in their workflow; a
  // self-hoster passes none and keeps every example default.
  const deployArgs = ["deploy"];
  if (gitCommitSha !== "") deployArgs.push("--var", `GIT_COMMIT_SHA:${gitCommitSha}`);
  for (const [name, value] of Object.entries(overrideVars)) {
    deployArgs.push("--var", `${name}:${value}`);
  }
  await wrangler(deployArgs);
}
