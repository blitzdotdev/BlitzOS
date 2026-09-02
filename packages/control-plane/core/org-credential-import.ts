import { HttpError, isBoolean, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import {
  liveOrgCredentials,
  orgCredentialAccess,
  orgCredentialValue,
  putOrgCredential,
  ORG_CREDENTIAL_MAX_BYTES,
  ORG_CREDENTIAL_MAX_COUNT,
  type OrgCredential,
  type OrgCredentialCaller,
} from "./org-credentials.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import type {
  ImportOrgCredentialsRequest,
  ImportOrgCredentialsResponse,
  OrgCredentialImportResult,
} from "./wire.js";

// The same name rule `parseOrgCredentialWrite` enforces, restated here so a
// parsed line can be refused with a per-line reason instead of a 400 that
// aborts the whole file.
const IMPORT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

/** The ceiling on the dotenv text itself. Two hundred keys of eight KB each
 * do not fit in one env file anybody writes by hand; half a megabyte is the
 * line between an env file and something else. */
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
 * a value IS the bytes on its line. A quoted value that never closes is the
 * start of a multi-line secret (a PEM, a JSON key), so its refusal names the
 * fix instead of storing the fragment.
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
    if (new TextEncoder().encode(value).byteLength > ORG_CREDENTIAL_MAX_BYTES) {
      refuse(
        name,
        line,
        `value must be at most ${String(ORG_CREDENTIAL_MAX_BYTES)} UTF-8 bytes`,
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

export function parseImportRequest(value: JsonValue): ImportOrgCredentialsRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const text = requiredString(value.text, "text", IMPORT_TEXT_MAX_BYTES);
  const result: ImportOrgCredentialsRequest = { text };
  if (value.dryRun !== undefined) {
    if (!isBoolean(value.dryRun)) throw new HttpError(400, "dryRun must be a boolean");
    result.dryRun = value.dryRun;
  }
  return result;
}

/** Who is importing: the acting membership, and the context the access
 * function grades it in. The gates are the store's own (§12): creating a key
 * is open to any active member, rotating an existing one needs write — a line
 * past the caller's authority is refused with its reason and the rest of the
 * file still imports. */
export interface ImportActor extends OrgCredentialCaller {
  membershipId: string;
}

/**
 * Stores each candidate through the same write the single-key PUT uses, so
 * import invents no second rotation semantics. Outcomes are store-level
 * facts: `rotated` means the value under a live name changed, `unchanged`
 * means it did not and nothing was written — the incoming plaintext is in
 * hand and the old value opens, so the comparison is free and keeps a re-run
 * of the same file from reading as two hundred rotations.
 *
 * A dry run walks the identical path minus the writes, which is what lets a
 * preview promise the real import will do what it showed.
 */
export async function importOrgCredentials(
  runtime: CoreRuntime,
  orgId: string,
  actor: ImportActor,
  input: ImportOrgCredentialsRequest,
): Promise<ImportOrgCredentialsResponse> {
  const { entries, linesRead } = parseEnvText(input.text);
  const live = await liveOrgCredentials(runtime.db, orgId);
  const liveByName = new Map<string, OrgCredential>(live.map((row) => [row.name, row]));
  let liveCount = live.length;
  const results: OrgCredentialImportResult[] = [];
  for (const entry of entries) {
    if (entry.reason !== undefined) {
      results.push({ name: entry.name, line: entry.line, outcome: "refused", reason: entry.reason });
      continue;
    }
    const existing = liveByName.get(entry.name);
    if (existing === undefined && liveCount >= ORG_CREDENTIAL_MAX_COUNT) {
      results.push({
        name: entry.name,
        line: entry.line,
        outcome: "refused",
        reason: `an organization may hold at most ${String(ORG_CREDENTIAL_MAX_COUNT)} credentials`,
      });
      continue;
    }
    if (existing !== undefined && !orgCredentialAccess(existing, actor).write) {
      results.push({
        name: entry.name,
        line: entry.line,
        outcome: "refused",
        reason: `write access to ${entry.name} required`,
      });
      continue;
    }
    let outcome: OrgCredentialImportResult["outcome"] = "stored";
    if (existing !== undefined) {
      let current: string | null = null;
      try {
        current = await orgCredentialValue(
          runtime.db,
          runtime.credentialMasterKey,
          orgId,
          entry.name,
        );
      } catch {
        // A ciphertext that will not open serves nobody; the write below is
        // the repair, so it counts as a rotation rather than a refusal.
      }
      outcome = current === entry.value ? "unchanged" : "rotated";
    }
    if (outcome !== "unchanged" && input.dryRun !== true) {
      await putOrgCredential(runtime, orgId, actor.membershipId, {
        name: entry.name,
        value: entry.value,
      });
    }
    if (existing === undefined) {
      liveCount += 1;
      // The row the next duplicate line grades against. The importer just
      // created it (or would, on a dry run), so the actor holds write.
      liveByName.set(entry.name, {
        id: "pending",
        org_id: orgId,
        name: entry.name,
        comment: null,
        created_by_membership_id: actor.membershipId,
        created_at: 0,
        updated_at: 0,
        grants: [{
          id: "pending",
          credential_id: "pending",
          subject_kind: "membership",
          subject_id: actor.membershipId,
          access: "write",
        }],
      });
    }
    results.push({ name: entry.name, line: entry.line, outcome });
  }
  return { results, linesRead };
}

/** The session-plane import door (plans/ORG-CREDENTIALS.md §7). The agent
 * plane's twin (`POST /agent/credentials/dotenv`) lives in
 * `core/agent-routes.ts` and calls the same import, so what an agent may do
 * is precisely what its person may do here. */
export function addOrgCredentialImportRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/orgs/:id/credentials/dotenv", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    if (principal.orgId === null) throw new HttpError(404, "organization not found");
    const requested = context.req.param("id");
    if (requested !== "self" && requested !== principal.orgId) {
      throw new HttpError(404, "organization not found");
    }
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseImportRequest(await readJson(context.req.raw, IMPORT_TEXT_MAX_BYTES * 2));
    return context.json<ImportOrgCredentialsResponse>(
      await importOrgCredentials(runtime, principal.orgId, {
        membershipId: principal.membershipId,
        orgRole: principal.role,
      }, input),
    );
  });
}
