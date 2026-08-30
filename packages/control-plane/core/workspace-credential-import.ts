import { boxCaller } from "./connections/pull-routes.js";
import { HttpError, isBoolean, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { requireWorkspaceAdmin } from "./workspace-access.js";
import {
  liveWorkspaceCredentials,
  putWorkspaceCredential,
  WORKSPACE_CREDENTIAL_MAX_BYTES,
  WORKSPACE_CREDENTIAL_MAX_COUNT,
  workspaceCredentialValue,
} from "./workspace-credentials.js";
import { workspaceById } from "./workspace-records.js";
import type {
  ImportWorkspaceCredentialsRequest,
  ImportWorkspaceCredentialsResponse,
  WorkspaceCredentialImportResult,
} from "./wire.js";

// The same name rule `parseWorkspaceCredential` enforces, restated here so a
// parsed line can be refused with a per-line reason instead of a 400 that
// aborts the whole file.
const IMPORT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

/** The ceiling on the dotenv text itself. Fifty keys of eight KB each fit
 * with room for comments; anything bigger is not an env file. */
export const IMPORT_TEXT_MAX_BYTES = 512 * 1024;

/** One parsed line: a candidate credential, or a refusal that names its
 * line. A refused entry never carries a value. */
interface ParsedEnvLine {
  name: string;
  line: number;
  value: string;
  reason?: string;
}

interface ParsedEnvText {
  entries: ParsedEnvLine[];
  linesRead: number;
}

/**
 * Parses dotenv text into candidates, refusing per line rather than per file.
 *
 * The grammar is the least surprising slice of dotenv: `NAME=value`, an
 * optional `export `, `#` comments, blank lines, and one matching pair of
 * surrounding quotes stripped. No escape expansion and no line continuation —
 * a value IS the bytes on its line, because `blitz-cred env` will print those
 * bytes back for a shell to eval, and the pull wire refuses a newline anyway.
 * A quoted value that never closes is the start of a multi-line secret (a
 * PEM, a JSON key), so its refusal names the fix instead of storing the
 * fragment.
 *
 * A duplicated name keeps the LAST line, which is how dotenv loaders resolve
 * it; the earlier line is reported rather than silently swallowed so the
 * caller learns the file disagrees with itself.
 */
export function parseEnvText(text: string): ParsedEnvText {
  const lines = text.split(/\r?\n/u);
  // A file that ends with a newline has not read one line more than a file
  // that does not; the split artifact after the last newline is not a line.
  if (lines.at(-1) === "") lines.pop();
  const entries: ParsedEnvLine[] = [];
  const lastByName = new Map<string, ParsedEnvLine>();
  const refuse = (name: string, line: number, reason: string): void => {
    entries.push({ name, line, value: "", reason });
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/u.exec(trimmed);
    if (match === null) {
      refuse(trimmed.split(/[=\s]/u)[0]?.slice(0, 64) ?? "", line, "not a NAME=value line");
      return;
    }
    const [, name = "", rest = ""] = match;
    if (!IMPORT_NAME.test(name)) {
      refuse(name.slice(0, 64), line, "name must be an environment variable name");
      return;
    }
    let value = rest;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length >= 2 && value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        refuse(name, line, "value spans more than one line; base64-encode it first");
        return;
      }
    }
    if (value === "") {
      refuse(name, line, "empty value");
      return;
    }
    if (new TextEncoder().encode(value).byteLength > WORKSPACE_CREDENTIAL_MAX_BYTES) {
      refuse(
        name,
        line,
        `value must be at most ${String(WORKSPACE_CREDENTIAL_MAX_BYTES)} UTF-8 bytes`,
      );
      return;
    }
    const earlier = lastByName.get(name);
    if (earlier !== undefined && earlier.reason === undefined) {
      earlier.reason = `superseded by line ${String(line)}`;
    }
    const entry: ParsedEnvLine = { name, line, value };
    lastByName.set(name, entry);
    entries.push(entry);
  });
  return { entries, linesRead: lines.length };
}

export function parseImportRequest(value: JsonValue): ImportWorkspaceCredentialsRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const text = requiredString(value.text, "text", IMPORT_TEXT_MAX_BYTES);
  const result: ImportWorkspaceCredentialsRequest = { text };
  if (value.label !== undefined && value.label !== null) {
    result.label = requiredString(value.label, "label", 128);
  }
  if (value.dryRun !== undefined) {
    if (!isBoolean(value.dryRun)) throw new HttpError(400, "dryRun must be a boolean");
    result.dryRun = value.dryRun;
  }
  return result;
}

/**
 * Stores each candidate through the same write the single-key PUT uses, so
 * import invents no second rotation semantics. Outcomes are store-level
 * facts: `rotated` means the value under a live name changed, `unchanged`
 * means it did not and nothing was written — the incoming plaintext is in
 * hand and the old value opens, so the comparison is free and keeps a re-run
 * of the same file from reading as fifty rotations.
 *
 * A dry run walks the identical path minus the writes, which is what lets the
 * webApp preview and `--check` promise the real import will do what they
 * showed.
 */
export async function importWorkspaceCredentials(
  runtime: CoreRuntime,
  workspaceId: string,
  membershipId: string,
  input: ImportWorkspaceCredentialsRequest,
): Promise<ImportWorkspaceCredentialsResponse> {
  const { entries, linesRead } = parseEnvText(input.text);
  const live = await liveWorkspaceCredentials(runtime.db, workspaceId);
  const liveNames = new Set(live.map(({ name }) => name));
  const results: WorkspaceCredentialImportResult[] = [];
  for (const entry of entries) {
    if (entry.reason !== undefined) {
      results.push({ name: entry.name, line: entry.line, outcome: "refused", reason: entry.reason });
      continue;
    }
    const exists = liveNames.has(entry.name);
    if (!exists && liveNames.size >= WORKSPACE_CREDENTIAL_MAX_COUNT) {
      results.push({
        name: entry.name,
        line: entry.line,
        outcome: "refused",
        reason: `a workspace may hold at most ${String(WORKSPACE_CREDENTIAL_MAX_COUNT)} credentials`,
      });
      continue;
    }
    let outcome: WorkspaceCredentialImportResult["outcome"] = "stored";
    if (exists) {
      let current: string | null = null;
      try {
        current = await workspaceCredentialValue(
          runtime.db,
          runtime.credentialMasterKey,
          workspaceId,
          entry.name,
        );
      } catch {
        // A ciphertext that will not open serves nobody; the write below is
        // the repair, so it counts as a rotation rather than a refusal.
      }
      outcome = current === entry.value ? "unchanged" : "rotated";
    }
    if (outcome !== "unchanged" && input.dryRun !== true) {
      const write: Parameters<typeof putWorkspaceCredential>[3] = {
        name: entry.name,
        value: entry.value,
      };
      if (input.label !== undefined) write.label = input.label;
      await putWorkspaceCredential(runtime, workspaceId, membershipId, write);
    }
    liveNames.add(entry.name);
    results.push({ name: entry.name, line: entry.line, outcome });
  }
  return { results, linesRead };
}

async function respondWithImport(
  context: CoreContext,
  runtime: CoreRuntime,
  workspaceId: string,
  principal: Principal,
): Promise<Response> {
  if (principal.membershipId === null) {
    throw new HttpError(403, "active membership required");
  }
  const input = parseImportRequest(await readJson(context.req.raw, IMPORT_TEXT_MAX_BYTES * 2));
  return context.json<ImportWorkspaceCredentialsResponse>(
    await importWorkspaceCredentials(runtime, workspaceId, principal.membershipId, input),
  );
}

/**
 * The env-file import, on both planes (one parser, two doors).
 *
 * `/workspaces/self/...` is the box plane: an agent runs `blitz-cred import`
 * and the acting member is the machine's member, resolved at call time
 * exactly as the pull wire resolves it. `/workspaces/:id/...` is the session
 * plane the webApp calls. Both land on the same import and the same
 * workspace-admin gate, so what an agent may do is precisely what its person
 * may do in the dialog.
 *
 * The self route is registered first: "self" would otherwise bind as `:id`
 * and be refused as a workspace nobody can see.
 */
export function addWorkspaceCredentialImportRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/workspaces/self/credentials/dotenv", async (context) => {
    const runtime = runtimeFactory(context);
    const { workspace, principal } = await boxCaller(runtime, context.req.raw);
    await requireWorkspaceAdmin(runtime.db, principal, workspace);
    return respondWithImport(context, runtime, workspace.id, principal);
  });

  router.post("/workspaces/:id/credentials/dotenv", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceById(runtime.db, context.req.param("id"));
    if (
      workspace === null
      || workspace.org_id === null
      || workspace.org_id !== principal.orgId
      || workspace.deleted_at !== null
    ) {
      throw new HttpError(404, "workspace not found");
    }
    await requireWorkspaceAdmin(runtime.db, principal, workspace);
    return respondWithImport(context, runtime, workspace.id, principal);
  });
}
