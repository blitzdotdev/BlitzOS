/**
 * The agent API route manifest (plans/ORG-CREDENTIALS.md §4): the one list of
 * what `GET /agent/api` documents. Each entry names its request and response
 * types by the names `packages/schema` exports; the generator
 * (`scripts/generate-agent-api.mjs`) turns those names into JSON Schema and
 * this list into the paths of `packages/schema/openapi/agent-api.json`.
 * Nothing in the document is hand-written: a route not listed here is
 * undocumented, and `test/agent-api-coverage.test.ts` fails on it.
 *
 * This module imports nothing at runtime, on purpose: node loads it with
 * type stripping to run the generator, and a runtime import of another core
 * module would drag the Worker graph in behind it.
 */

/** Names the generator resolves against `packages/schema/src/index.ts`. A
 * name that is not exported there fails generation, not the reader. */
export type AgentApiTypeName =
  | "AgentCredentialsResponse"
  | "AgentCredentialTokenResponse"
  | "PutAgentCredentialRequest"
  | "PutOrgCredentialResponse"
  | "ImportOrgCredentialsRequest"
  | "ImportOrgCredentialsResponse"
  | "ProposeGrantChangesRequest"
  | "ProposeGrantChangesResponse"
  | "GrantProposalView"
  | "ApiError"
  | "CredentialRequestFiledError";

export type AgentApiMethod = "GET" | "POST" | "PUT";

export interface AgentApiSuccess {
  readonly status: 200 | 201;
  /** The response type, or `"document"` for the one route whose body is
   * the OpenAPI document itself and so has no schema of its own. */
  readonly body: AgentApiTypeName | "document";
  readonly description: string;
}

export interface AgentApiRefusal {
  readonly status: 400 | 401 | 403 | 404 | 409;
  readonly body: "ApiError" | "CredentialRequestFiledError";
  readonly description: string;
}

export interface AgentApiParameter {
  readonly name: string;
  readonly description: string;
}

export interface AgentApiRoute {
  readonly method: AgentApiMethod;
  /** Hono style, exactly as registered: `:name` marks a path parameter. */
  readonly path: `/agent/${string}`;
  readonly summary: string;
  readonly description: string;
  /** One entry per `:param` in `path`, in path order; the generator refuses
   * a mismatch. */
  readonly parameters?: readonly AgentApiParameter[];
  readonly request?: AgentApiTypeName;
  readonly responses: readonly AgentApiSuccess[];
  /** Refusals this handler throws on top of `AGENT_API_SHARED_REFUSALS`. */
  readonly refusals: readonly AgentApiRefusal[];
}

/** What `boxCaller` refuses before any handler runs, so every route below
 * answers with these too. */
export const AGENT_API_SHARED_REFUSALS: readonly AgentApiRefusal[] = [
  {
    status: 401,
    body: "ApiError",
    description: "The bearer is not a live machine credential.",
  },
  {
    status: 409,
    body: "ApiError",
    description: "The machine has no workspace, or its workspace has no organization.",
  },
];

export const AGENT_ROUTES: readonly AgentApiRoute[] = [
  {
    method: "GET",
    path: "/agent/api",
    summary: "This document",
    description:
      "The OpenAPI 3.1 description of every /agent/* route, generated from the "
      + "control plane's own wire types. Read it, then call what it lists.",
    responses: [{ status: 200, body: "document", description: "The OpenAPI document." }],
    refusals: [],
  },
  {
    method: "GET",
    path: "/agent/credentials",
    summary: "List the credentials this machine may ask for",
    description:
      "Names, scopes and comments only — never a value. 'connection' rows come "
      + "from the workspace's connection manifest; 'org' rows are org credentials "
      + "the machine's member may read, 'writable' when they may rotate them too. "
      + "Grants and the manifest are read on every call.",
    responses: [{ status: 200, body: "AgentCredentialsResponse", description: "The list." }],
    refusals: [],
  },
  {
    method: "POST",
    path: "/agent/credentials/:name/token",
    summary: "Resolve one credential for immediate use",
    description:
      "An org connection of that name mints a token through the workspace's own "
      + "connection; otherwise an org credential the member may read is served. "
      + "Use the token once and ask again next time: 'expiresAt' is when to "
      + "re-ask, and a rotation or revoke takes effect on the next call.",
    parameters: [{ name: "name", description: "A name from GET /agent/credentials." }],
    responses: [{ status: 200, body: "AgentCredentialTokenResponse", description: "The token, and how to present it." }],
    refusals: [
      {
        status: 403,
        body: "ApiError",
        description: "The connection denied this machine's member.",
      },
      {
        status: 404,
        body: "CredentialRequestFiledError",
        description:
          "Not connected here, or not granted to this member. A request was filed "
          + "for the person; run `blitz connections open <name>` and retry after "
          + "they connect it.",
      },
    ],
  },
  {
    method: "PUT",
    path: "/agent/credentials/:name",
    summary: "Create or rotate an org credential",
    description:
      "One deliberate write with the comment that explains the key. Any active "
      + "member may create (and receives the write grant); rotating needs write "
      + "access. The value never comes back out.",
    parameters: [{
      name: "name",
      description: "An environment variable name: letters, digits and underscores, not starting with a digit.",
    }],
    request: "PutAgentCredentialRequest",
    responses: [
      { status: 200, body: "PutOrgCredentialResponse", description: "Rotated." },
      { status: 201, body: "PutOrgCredentialResponse", description: "Created." },
    ],
    refusals: [
      {
        status: 400,
        body: "ApiError",
        description: "The name is not an environment variable name, or the body is malformed.",
      },
      {
        status: 403,
        body: "ApiError",
        description: "No active membership, or no write access to an existing name.",
      },
    ],
  },
  {
    method: "POST",
    path: "/agent/credentials/dotenv",
    summary: "Import a dotenv file as org credentials",
    description:
      "Each KEY=value line becomes one org credential, with no comment. A line "
      + "the member may not write is refused by name and the rest still imports. "
      + "'dryRun' parses and reports without storing anything.",
    request: "ImportOrgCredentialsRequest",
    responses: [{ status: 200, body: "ImportOrgCredentialsResponse", description: "One result per line." }],
    refusals: [
      { status: 400, body: "ApiError", description: "The body is malformed." },
      { status: 403, body: "ApiError", description: "No active membership." },
    ],
  },
  {
    method: "POST",
    path: "/agent/credentials/grant-proposals",
    summary: "Propose grant changes for a person to approve",
    description:
      "Nothing applies until the machine's member (or an org admin) approves it "
      + "in the browser, possibly narrower than proposed. Poll the returned id "
      + "until 'state' leaves 'pending'.",
    request: "ProposeGrantChangesRequest",
    responses: [{ status: 201, body: "ProposeGrantChangesResponse", description: "Filed, pending approval." }],
    refusals: [
      {
        status: 400,
        body: "ApiError",
        description: "The change list is malformed, empty, or names a subject outside the organization.",
      },
      {
        status: 403,
        body: "ApiError",
        description: "No active membership, or a change past the member's write authority (named in the error).",
      },
    ],
  },
  {
    method: "GET",
    path: "/agent/grant-proposals/:id",
    summary: "Poll a grant proposal",
    description:
      "Scoped to the proposing machine's organization. A proposal lives in "
      + "memory for an hour; a 404 after a control-plane restart means propose "
      + "again.",
    parameters: [{ name: "id", description: "The id POST /agent/credentials/grant-proposals returned." }],
    responses: [{ status: 200, body: "GrantProposalView", description: "The proposal and what applied." }],
    refusals: [
      { status: 404, body: "ApiError", description: "Unknown, expired, or another organization's proposal." },
    ],
  },
];
