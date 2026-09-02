#!/usr/bin/env node

// Generates packages/schema/openapi/agent-api.json — the OpenAPI 3.1 document
// GET /agent/api serves (plans/ORG-CREDENTIALS.md §4) — from two inputs and
// nothing else:
//
//   - the wire types in packages/schema/src, turned into JSON Schema by
//     ts-json-schema-generator (JSDoc comments become descriptions), and
//   - the route manifest in core/agent-api-manifest.ts, which names each
//     route's request and response types and the refusals it throws.
//
// No JSON Schema is written by hand anywhere. The artifact is checked in so the
// Worker can bundle it (core/agent-api.ts); test/agent-api-generate.test.mjs
// regenerates it and fails on any byte of difference, so it cannot go stale.
//
//   npm run openapi:generate -w @blitzos/control-plane
//
// Plain Node: the manifest is a .ts module that imports nothing at runtime, so
// Node's type stripping loads it directly (--experimental-strip-types on 22.x
// before 22.18; the default since).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import { isNonEmptyString, isTable } from "./lib/values.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const SCHEMA_DIR = path.resolve(PACKAGE_DIR, "../schema");
const MANIFEST_PATH = path.join(PACKAGE_DIR, "core/agent-api-manifest.ts");

/** Where the artifact lives. The Worker imports it from here. */
export const ARTIFACT_PATH = path.join(SCHEMA_DIR, "openapi/agent-api.json");

const DEFINITIONS_PREFIX = "#/definitions/";
const COMPONENTS_PREFIX = "#/components/schemas/";
const SECURITY_SCHEME = "machineBearer";

/**
 * @typedef {import("../core/agent-api-manifest.ts").AgentApiRoute} AgentApiRoute
 * @typedef {import("../core/agent-api-manifest.ts").AgentApiRefusal} AgentApiRefusal
 * @typedef {import("../core/agent-api-manifest.ts").AgentApiSuccess} AgentApiSuccess
 * @typedef {import("../core/agent-api-manifest.ts").AgentApiTypeName} AgentApiTypeName
 * @typedef {{ routes: readonly AgentApiRoute[], sharedRefusals: readonly AgentApiRefusal[] }} Manifest
 */

/** @returns {Promise<Manifest>} */
export async function loadManifest() {
  const module = await import(pathToFileURL(MANIFEST_PATH).href);
  return { routes: module.AGENT_ROUTES, sharedRefusals: module.AGENT_API_SHARED_REFUSALS };
}

/**
 * Every type name the manifest mentions, in first-use order.
 *
 * @param {Manifest} manifest
 * @returns {AgentApiTypeName[]}
 */
function mentionedTypeNames(manifest) {
  /** @type {Set<AgentApiTypeName>} */
  const names = new Set();
  for (const refusal of manifest.sharedRefusals) names.add(refusal.body);
  for (const route of manifest.routes) {
    if (route.request !== undefined) names.add(route.request);
    for (const response of route.responses) {
      if (response.body !== "document") names.add(response.body);
    }
    for (const refusal of route.refusals) names.add(refusal.body);
  }
  return [...names];
}

/**
 * Rewrites every `$ref` the generator emitted under `#/definitions/` to the
 * OpenAPI components location. A walk, not a text replace: a description is
 * free to quote the old prefix.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function relocateRefs(value) {
  if (Array.isArray(value)) return value.map(relocateRefs);
  if (!isTable(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "$ref" && isNonEmptyString(entry) && entry.startsWith(DEFINITIONS_PREFIX)) {
      return [key, COMPONENTS_PREFIX + entry.slice(DEFINITIONS_PREFIX.length)];
    }
    return [key, relocateRefs(entry)];
  }));
}

/**
 * JSON Schema for every named type, plus every type those reach, keyed by
 * name and sorted so the output is a pure function of the inputs.
 *
 * @param {readonly AgentApiTypeName[]} typeNames
 * @returns {Record<string, unknown>}
 */
export function schemaComponents(typeNames) {
  const generator = createGenerator({
    path: path.join(SCHEMA_DIR, "src/index.ts"),
    tsconfig: path.join(SCHEMA_DIR, "tsconfig.json"),
    expose: "export",
    topRef: true,
    jsDoc: "extended",
    additionalProperties: false,
    skipTypeCheck: true,
  });
  /** @type {Record<string, unknown>} */
  const definitions = {};
  for (const name of typeNames) {
    // Throws NoRootTypeError for a name the schema package does not export:
    // the manifest is wrong, and the document must not paper over it.
    const schema = generator.createSchema(name);
    if (schema.$ref !== DEFINITIONS_PREFIX + name) {
      throw new Error(`expected ${name} to generate as a named definition, got ${String(schema.$ref)}`);
    }
    for (const [key, definition] of Object.entries(schema.definitions ?? {})) {
      definitions[key] = definition;
    }
  }
  return Object.fromEntries(
    Object.keys(definitions).sort().map((key) => [key, relocateRefs(definitions[key])]),
  );
}

/** @param {string} name */
const schemaRef = (name) => ({ $ref: COMPONENTS_PREFIX + name });

/** @param {string} name */
const jsonBody = (name) => ({ "application/json": { schema: schemaRef(name) } });

/**
 * `:name` → `{name}`, and the parameter list the manifest must have described
 * in the same order.
 *
 * @param {AgentApiRoute} route
 */
function pathTemplate(route) {
  const declared = route.parameters ?? [];
  const found = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]);
  const declaredNames = declared.map((parameter) => parameter.name);
  if (JSON.stringify(found) !== JSON.stringify(declaredNames)) {
    throw new Error(
      `${route.method} ${route.path} declares parameters [${declaredNames.join(", ")}] but its path has [${found.join(", ")}]`,
    );
  }
  return {
    template: route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, "{$1}"),
    parameters: declared.map((parameter) => ({
      name: parameter.name,
      in: "path",
      required: true,
      description: parameter.description,
      schema: { type: "string" },
    })),
  };
}

/**
 * One response object per status, shared refusals included. Two entries for
 * one status would be a manifest bug, so it throws rather than picking one.
 *
 * @param {AgentApiRoute} route
 * @param {readonly AgentApiRefusal[]} sharedRefusals
 */
function responses(route, sharedRefusals) {
  /** @type {(AgentApiSuccess | AgentApiRefusal)[]} */
  const all = [...route.responses, ...route.refusals, ...sharedRefusals];
  const byStatus = new Map();
  for (const entry of all) {
    if (byStatus.has(entry.status)) {
      throw new Error(`${route.method} ${route.path} documents status ${String(entry.status)} twice`);
    }
    byStatus.set(entry.status, entry);
  }
  return Object.fromEntries([...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, entry]) => [
      String(status),
      entry.body === "document"
        ? { description: entry.description, content: { "application/json": {} } }
        : { description: entry.description, content: jsonBody(entry.body) },
    ]));
}

/**
 * @param {AgentApiRoute} route
 * @param {readonly AgentApiRefusal[]} sharedRefusals
 */
function operation(route, sharedRefusals) {
  const { parameters } = pathTemplate(route);
  // Assigned in this order on purpose: it is the key order of the artifact.
  /** @type {Record<string, unknown>} */
  const entry = { summary: route.summary, description: route.description };
  if (parameters.length > 0) entry.parameters = parameters;
  if (route.request !== undefined) {
    entry.requestBody = { required: true, content: jsonBody(route.request) };
  }
  entry.responses = responses(route, sharedRefusals);
  return entry;
}

/**
 * The whole document as an object. Key order is fixed here and the schemas
 * are sorted, so serializing it is deterministic.
 *
 * @param {Manifest} manifest
 */
export function agentApiDocument(manifest) {
  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};
  for (const route of manifest.routes) {
    const { template } = pathTemplate(route);
    const method = route.method.toLowerCase();
    const entry = paths[template] ?? (paths[template] = {});
    if (entry[method] !== undefined) {
      throw new Error(`${route.method} ${route.path} is listed twice in the manifest`);
    }
    entry[method] = operation(route, manifest.sharedRefusals);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "BlitzOS agent API",
      version: "1",
      description:
        "The routes a machine drives with its own credential, under /agent/. "
        + "Generated from the control plane's wire types and route manifest by "
        + "packages/control-plane/scripts/generate-agent-api.mjs; never edited by "
        + "hand. The origin is the control plane the machine phoned home to "
        + "(/var/lib/blitz/origin on a box), and every route wants the bearer "
        + "`blitz-cred api-token` prints. Never print a token you receive.",
    },
    security: [{ [SECURITY_SCHEME]: [] }],
    paths,
    components: {
      securitySchemes: {
        [SECURITY_SCHEME]: {
          type: "http",
          scheme: "bearer",
          description:
            "The machine's own credential. It acts as the member who owns the "
            + "machine, resolved on every call.",
        },
      },
      schemas: schemaComponents(mentionedTypeNames(manifest)),
    },
  };
}

/** The artifact's exact bytes. */
export async function generateAgentApiDocument() {
  return `${JSON.stringify(agentApiDocument(await loadManifest()), null, 2)}\n`;
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;

if (invokedUrl === import.meta.url) {
  const next = await generateAgentApiDocument();
  const previous = await readFile(ARTIFACT_PATH, "utf8").catch(() => null);
  if (previous === next) {
    process.stdout.write(`${path.relative(process.cwd(), ARTIFACT_PATH)} is current\n`);
  } else {
    await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await writeFile(ARTIFACT_PATH, next, "utf8");
    process.stdout.write(`wrote ${path.relative(process.cwd(), ARTIFACT_PATH)}\n`);
  }
}
