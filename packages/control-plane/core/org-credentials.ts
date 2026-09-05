import { openRoot, sealRoot } from "./connections/root-crypto.js";
import type { Db, Query } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { HttpError, isRecord, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRuntime } from "./runtime.js";
import type {
  OrgCredentialGrantSubjectKind,
  OrgCredentialGrantView,
  OrgCredentialView,
  PutOrgCredentialRequest,
} from "./wire.js";

/** The org credential store (plans/ORG-CREDENTIALS.md §5-§7): the one static
 * credential plane. Values seal under CRED_MASTER_KEY; access rides the
 * explicit grant allowlist plus the org-admin implication. */

/** The env var name an agent asks for: a leading letter, then word chars. */
export const ORG_CREDENTIAL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

/** A value is a single opaque secret, not a document. */
export const ORG_CREDENTIAL_MAX_BYTES = 8 * 1024;

/** How many live credentials one organization may hold. */
export const ORG_CREDENTIAL_MAX_COUNT = 200;

/** A comment is one line of prose about what the key is FOR. */
export const ORG_CREDENTIAL_COMMENT_MAX = 256;

/** How many grants one credential may carry. */
export const ORG_CREDENTIAL_MAX_GRANTS = 100;

/** The AAD every org credential is sealed under. It binds a ciphertext to the
 * row it belongs to, so a value cannot be moved to another organization or
 * renamed onto another variable and still open. */
export function orgCredentialAad(orgId: string, name: string): string {
  return `orgcred:${orgId}:${name}`;
}

/** A credential to everything except the one reader of a value: a
 * ciphertext is never selected to answer a names-only question. */
export interface OrgCredentialRow {
  id: string;
  org_id: string;
  name: string;
  comment: string | null;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
}

export interface OrgCredentialGrantRow {
  id: string;
  credential_id: string;
  subject_kind: OrgCredentialGrantSubjectKind;
  subject_id: string | null;
  access: "read" | "write";
}

/** One credential with its allowlist loaded — the shape the access function
 * grades. */
export interface OrgCredential extends OrgCredentialRow {
  grants: OrgCredentialGrantRow[];
}

const CREDENTIAL_COLUMNS =
  "id, org_id, name, comment, created_by_membership_id, created_at, updated_at";

export async function liveOrgCredentials(db: Db, orgId: string): Promise<OrgCredential[]> {
  const credentials = await rows<OrgCredentialRow>(db, {
    q: `SELECT ${CREDENTIAL_COLUMNS} FROM org_credentials
        WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY name`,
    v: [orgId],
  });
  const grants = await grantsForCredentials(db, credentials.map(({ id }) => id));
  return credentials.map((row) => ({
    ...row,
    grants: grants.filter((grant) => grant.credential_id === row.id),
  }));
}

export async function orgCredentialByName(
  db: Db,
  orgId: string,
  name: string,
): Promise<OrgCredential | null> {
  const row = await first<OrgCredentialRow>(db, {
    q: `SELECT ${CREDENTIAL_COLUMNS} FROM org_credentials
        WHERE org_id = ?1 AND name = ?2 AND revoked_at IS NULL LIMIT 1`,
    v: [orgId, name],
  });
  if (row === null) return null;
  return { ...row, grants: await grantsForCredentials(db, [row.id]) };
}

async function grantsForCredentials(
  db: Db,
  credentialIds: readonly string[],
): Promise<OrgCredentialGrantRow[]> {
  if (credentialIds.length === 0) return [];
  const placeholders = credentialIds.map((_id, index) => `?${String(index + 1)}`).join(", ");
  // Ordered by subject, not insertion, so the wire view is deterministic.
  return rows<OrgCredentialGrantRow>(db, {
    q: `SELECT id, credential_id, subject_kind, subject_id, access
        FROM org_credential_grants
        WHERE credential_id IN (${placeholders})
        ORDER BY credential_id, subject_kind, coalesce(subject_id, ''), access`,
    v: [...credentialIds],
  });
}

/** The value behind one live name, or null when the organization holds no
 * such credential. Callers gate on `orgCredentialAccess` FIRST. */
export async function orgCredentialValue(
  db: Db,
  key: CryptoKey,
  orgId: string,
  name: string,
): Promise<string | null> {
  const row = await first<{ ciphertext: string }>(db, {
    q: `SELECT ciphertext FROM org_credentials
        WHERE org_id = ?1 AND name = ?2 AND revoked_at IS NULL LIMIT 1`,
    v: [orgId, name],
  });
  if (row === null) return null;
  try {
    return await openRoot(key, orgCredentialAad(orgId, name), row.ciphertext);
  } catch {
    // A ciphertext that will not open is a credential nobody can use.
    // Refusing loudly is the honest answer: silently serving nothing would
    // read to an agent as "this organization never had that key".
    throw new HttpError(409, `org credential ${name} cannot be opened`);
  }
}

/** Who is asking. `workspaceId` is present only for a machine read: a
 * session caller stands in no workspace. */
export interface OrgCredentialCaller {
  workspaceId?: string;
  membershipId: string | null;
  orgRole: "admin" | "member" | null;
}

export interface OrgCredentialAccessDecision {
  read: boolean;
  write: boolean;
}

/** The one access function (§6). Org admins implicitly read and write
 * everything. Write comes from a `write` grant whose subject covers the
 * caller; read is write plus any covering grant. Reads require a resolved
 * active membership: a machine whose member left the org gets nothing. */
export function orgCredentialAccess(
  credential: Pick<OrgCredential, "grants">,
  caller: OrgCredentialCaller,
): OrgCredentialAccessDecision {
  if (caller.membershipId === null) return { read: false, write: false };
  const covers = (grant: OrgCredentialGrantRow): boolean =>
    grant.subject_kind === "org"
    || (grant.subject_kind === "workspace"
      && caller.workspaceId !== undefined
      && grant.subject_id === caller.workspaceId)
    || (grant.subject_kind === "membership" && grant.subject_id === caller.membershipId);
  const write = caller.orgRole === "admin"
    || credential.grants.some((grant) => grant.access === "write" && covers(grant));
  const read = write || credential.grants.some(covers);
  return { read, write };
}

function grantView(grant: OrgCredentialGrantRow): OrgCredentialGrantView {
  return { subjectKind: grant.subject_kind, subjectId: grant.subject_id, access: grant.access };
}

/** The wire view. `grants` is the full set only where the viewer may edit it
 * (writers and org admins); a plain reader learns the names, not the
 * audience. */
export function orgCredentialView(
  credential: OrgCredential,
  includeGrants: boolean,
): OrgCredentialView {
  return {
    id: credential.id,
    name: credential.name,
    comment: credential.comment,
    createdByMembershipId: credential.created_by_membership_id,
    createdAt: credential.created_at,
    updatedAt: credential.updated_at,
    grants: includeGrants ? credential.grants.map(grantView) : [],
  };
}

/** One parsed grant, refused before any write can trip the unique index. */
export function parseGrant(value: JsonValue, field: string): OrgCredentialGrantView {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  const { subjectKind, subjectId, access } = value;
  if (subjectKind !== "org" && subjectKind !== "workspace" && subjectKind !== "membership") {
    throw new HttpError(400, `${field}.subjectKind must be org, workspace or membership`);
  }
  if (access !== "read" && access !== "write") {
    throw new HttpError(400, `${field}.access must be read or write`);
  }
  if (subjectKind === "org") {
    if (subjectId !== null && subjectId !== undefined) {
      throw new HttpError(400, `${field}.subjectId must be null for an org grant`);
    }
    return { subjectKind, subjectId: null, access };
  }
  return { subjectKind, subjectId: requiredString(subjectId, `${field}.subjectId`, 256), access };
}

export function parseGrantList(value: JsonValue, field = "grants"): OrgCredentialGrantView[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array`);
  if (value.length > ORG_CREDENTIAL_MAX_GRANTS) {
    throw new HttpError(
      400,
      `a credential may carry at most ${String(ORG_CREDENTIAL_MAX_GRANTS)} grants`,
    );
  }
  const grants = value.map((entry, index) => parseGrant(entry, `${field}[${String(index)}]`));
  const seen = new Set<string>();
  for (const grant of grants) {
    const subject = `${grant.subjectKind}:${grant.subjectId ?? ""}`;
    if (seen.has(subject)) {
      throw new HttpError(400, `${field} names the same subject twice`);
    }
    seen.add(subject);
  }
  return grants;
}

export function parseOrgCredentialWrite(value: JsonValue): PutOrgCredentialRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 128);
  if (!ORG_CREDENTIAL_NAME.test(name)) {
    throw new HttpError(400, "name must be an environment variable name");
  }
  const result: PutOrgCredentialRequest = {
    name,
    value: parseCredentialValue(value.value),
  };
  const comment = parseCredentialComment(value.comment);
  if (comment !== undefined) result.comment = comment;
  if (value.grants !== undefined) result.grants = parseGrantList(value.grants);
  return result;
}

export function parseCredentialValue(value: JsonValue | undefined): string {
  const secret = requiredString(value, "value", ORG_CREDENTIAL_MAX_BYTES);
  if (new TextEncoder().encode(secret).byteLength > ORG_CREDENTIAL_MAX_BYTES) {
    throw new HttpError(
      400,
      `value must be at most ${String(ORG_CREDENTIAL_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  return secret;
}

/** Tri-state on purpose: absent (undefined) keeps the live row's comment
 * across a rotation, an explicit null clears it, a string sets it. */
export function parseCredentialComment(
  value: JsonValue | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const comment = requiredString(value, "comment", ORG_CREDENTIAL_COMMENT_MAX);
  if (/[\r\n\0]/u.test(comment)) {
    throw new HttpError(400, "comment must be a single line");
  }
  return comment;
}

function grantEventDetail(
  credential: Pick<OrgCredentialRow, "id" | "org_id" | "name">,
  grant: OrgCredentialGrantView,
  actingMembershipId: string,
): string {
  return JSON.stringify({
    kind: "org_credential_grant",
    org_id: credential.org_id,
    credential_id: credential.id,
    credential_name: credential.name,
    subject_kind: grant.subjectKind,
    subject_id: grant.subjectId,
    access: grant.access,
    acting_membership_id: actingMembershipId,
  });
}

function grantEventQuery(
  event: "approved" | "revoked",
  credential: Pick<OrgCredentialRow, "id" | "org_id" | "name">,
  grant: OrgCredentialGrantView,
  actingMembershipId: string,
  now: number,
): Query {
  return {
    q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
        VALUES (NULL, ?1, ?2, ?3)`,
    v: [event, grantEventDetail(credential, grant, actingMembershipId), now],
  };
}

export interface PutOrgCredentialInput {
  name: string;
  value: string;
  comment?: string | null;
}

export interface PutOrgCredentialOutcome {
  credential: OrgCredential;
  created: boolean;
}

/** Writes one credential, replacing whatever live row held that name.
 * Add and rotate are the same act: the partial unique index allows one live
 * row per name, so a second write revokes the first in the same transaction.
 * The revoked row stays as the audit of a rotation, and the grant rows move
 * onto the new row — rotation changes the secret, not who may use it. A
 * create writes the creator's own `write` grant in the same transaction
 * (§12), with its `approved` event. */
export async function putOrgCredential(
  runtime: CoreRuntime,
  orgId: string,
  membershipId: string,
  input: PutOrgCredentialInput,
  now = Date.now(),
): Promise<PutOrgCredentialOutcome> {
  const ciphertext = await sealRoot(
    runtime.credentialMasterKey,
    orgCredentialAad(orgId, input.name),
    input.value,
  );
  const existing = await orgCredentialByName(runtime.db, orgId, input.name);
  if (existing === null) {
    const count = await first<{ count: number }>(runtime.db, {
      q: `SELECT COUNT(*) AS count FROM org_credentials
          WHERE org_id = ?1 AND revoked_at IS NULL`,
      v: [orgId],
    });
    if ((count?.count ?? 0) >= ORG_CREDENTIAL_MAX_COUNT) {
      throw new HttpError(
        409,
        `an organization may hold at most ${String(ORG_CREDENTIAL_MAX_COUNT)} credentials`,
      );
    }
  }
  const id = crypto.randomUUID();
  // Documentation outlives the value it documents: a write that carries no
  // comment keeps the live row's, because a rotation changes the secret, not
  // what the secret is for. An env-file re-import must not erase them.
  const comment = input.comment !== undefined
    ? input.comment
    : existing?.comment ?? null;
  const insert: Query = {
    q: `INSERT INTO org_credentials
        (id, org_id, name, comment, ciphertext,
         created_by_membership_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    v: [id, orgId, input.name, comment, ciphertext, membershipId, now],
  };
  if (existing !== null) {
    await transaction(runtime.db, [
      {
        q: `UPDATE org_credentials SET revoked_at = ?1, updated_at = ?1
            WHERE id = ?2 AND revoked_at IS NULL`,
        v: [now, existing.id],
      },
      insert,
      // The allowlist follows the name across a rotation. Grant rows keep
      // their identity and provenance; only the pointer moves.
      {
        q: "UPDATE org_credential_grants SET credential_id = ?1 WHERE credential_id = ?2",
        v: [id, existing.id],
      },
    ]);
    const rotated = await orgCredentialByName(runtime.db, orgId, input.name);
    if (rotated === null) throw new Error("org credential disappeared during rotation");
    return { credential: rotated, created: false };
  }
  const creatorGrant: OrgCredentialGrantView = {
    subjectKind: "membership",
    subjectId: membershipId,
    access: "write",
  };
  await transaction(runtime.db, [
    insert,
    {
      q: `INSERT INTO org_credential_grants
          (id, credential_id, subject_kind, subject_id, access,
           created_by_membership_id, created_at)
          VALUES (?1, ?2, 'membership', ?3, 'write', ?3, ?4)`,
      v: [crypto.randomUUID(), id, membershipId, now],
    },
    grantEventQuery(
      "approved",
      { id, org_id: orgId, name: input.name },
      creatorGrant,
      membershipId,
      now,
    ),
  ]);
  const created = await orgCredentialByName(runtime.db, orgId, input.name);
  if (created === null) throw new Error("org credential disappeared during create");
  return { credential: created, created: true };
}

/** A revoke refuses the next read. The credential row stays as the record
 * that this organization once held the name; the grant rows go — they are
 * ACL state, not audit, and the audit lives in `credential_events`. */
export async function revokeOrgCredential(
  runtime: CoreRuntime,
  orgId: string,
  name: string,
  now = Date.now(),
): Promise<boolean> {
  const revoked = await rows<{ id: string }>(runtime.db, {
    q: `UPDATE org_credentials SET revoked_at = ?1, updated_at = ?1
        WHERE org_id = ?2 AND name = ?3 AND revoked_at IS NULL
        RETURNING id`,
    v: [now, orgId, name],
  });
  const id = revoked[0]?.id;
  if (id === undefined) return false;
  await rows(runtime.db, {
    q: "DELETE FROM org_credential_grants WHERE credential_id = ?1",
    v: [id],
  });
  return true;
}

const grantKey = (grant: OrgCredentialGrantView): string =>
  `${grant.subjectKind}:${grant.subjectId ?? ""}:${grant.access}`;

export interface OrgCredentialGrantReplacement {
  credential: OrgCredential;
  grants: readonly OrgCredentialGrantView[];
}

/** The grants this replacement will INSERT. A grant the credential already
 * carries at the same level is kept, and is not written again. */
function addedGrants(replacement: OrgCredentialGrantReplacement): OrgCredentialGrantView[] {
  const currentByKey = new Set(
    replacement.credential.grants.map((grant) => grantKey(grantView(grant))),
  );
  return replacement.grants.filter((grant) => !currentByKey.has(grantKey(grant)));
}

function grantReplacementQueries(
  replacement: OrgCredentialGrantReplacement,
  actingMembershipId: string,
  now: number,
): Query[] {
  const { credential, grants } = replacement;
  const nextByKey = new Map(grants.map((grant) => [grantKey(grant), grant]));
  const removed = credential.grants.filter(
    (grant) => !nextByKey.has(grantKey(grantView(grant))),
  );
  const added = addedGrants(replacement);
  return [
    ...removed.map((grant): Query => ({
      q: "DELETE FROM org_credential_grants WHERE id = ?1",
      v: [grant.id],
    })),
    ...removed.map((grant) =>
      grantEventQuery("revoked", credential, grantView(grant), actingMembershipId, now),
    ),
    ...added.map((grant): Query => ({
      q: `INSERT INTO org_credential_grants
          (id, credential_id, subject_kind, subject_id, access,
           created_by_membership_id, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      v: [
        crypto.randomUUID(),
        credential.id,
        grant.subjectKind,
        grant.subjectId,
        grant.access,
        actingMembershipId,
        now,
      ],
    })),
    ...added.map((grant) =>
      grantEventQuery("approved", credential, grant, actingMembershipId, now),
    ),
  ];
}

/** Replaces several credentials' grant sets in one transaction. Every actual
 * add or remove writes its `credential_events` row, while kept grants retain
 * their provenance. Only the grants this write INSERTS are validated; the cap
 * still counts the whole set. `assertGrantSubjects` says why. */
export async function replaceOrgCredentialGrantSets(
  runtime: CoreRuntime,
  orgId: string,
  actingMembershipId: string,
  replacements: readonly OrgCredentialGrantReplacement[],
  now = Date.now(),
  /** Statements that must land with the grants or not at all — a grant
   * proposal settling itself, say. They run even when no grant changes. */
  alongside: readonly Query[] = [],
): Promise<void> {
  for (const { grants } of replacements) {
    if (grants.length > ORG_CREDENTIAL_MAX_GRANTS) {
      throw new HttpError(
        400,
        `a credential may carry at most ${String(ORG_CREDENTIAL_MAX_GRANTS)} grants`,
      );
    }
  }
  await assertGrantSubjects(
    runtime.db,
    orgId,
    replacements.flatMap(addedGrants),
  );
  const statements = [
    ...replacements.flatMap((replacement) =>
      grantReplacementQueries(replacement, actingMembershipId, now)),
    ...alongside,
  ];
  if (statements.length > 0) await transaction(runtime.db, statements);
}

/** Replaces one credential's grant set atomically and returns its live view. */
export async function replaceOrgCredentialGrants(
  runtime: CoreRuntime,
  credential: OrgCredential,
  actingMembershipId: string,
  grants: readonly OrgCredentialGrantView[],
  now = Date.now(),
): Promise<OrgCredential> {
  await replaceOrgCredentialGrantSets(
    runtime,
    credential.org_id,
    actingMembershipId,
    [{ credential, grants }],
    now,
  );
  return {
    ...credential,
    grants: await grantsForCredentials(runtime.db, [credential.id]),
  };
}

/** The subjects a grant list names that are not valid in this organization —
 * workspaces not live in it, memberships not active in it — keyed
 * `<kind>:<id>` so a caller can name the grant that carried one. */
export async function invalidGrantSubjects(
  db: Db,
  orgId: string,
  grants: readonly OrgCredentialGrantView[],
): Promise<Set<string>> {
  const invalid = new Set<string>();
  for (const [kind, select] of [
    ["workspace", "SELECT id FROM workspaces WHERE org_id = ?1 AND deleted_at IS NULL"],
    ["membership", "SELECT id FROM memberships WHERE org_id = ?1 AND status = 'active'"],
  ] as const) {
    const ids = [...new Set(grants.flatMap((grant) =>
      grant.subjectKind === kind && grant.subjectId !== null ? [grant.subjectId] : []))];
    if (ids.length === 0) continue;
    const placeholders = ids.map((_id, index) => `?${String(index + 2)}`).join(", ");
    const known = await rows<{ id: string }>(db, {
      q: `${select} AND id IN (${placeholders})`,
      v: [orgId, ...ids],
    });
    const knownIds = new Set(known.map(({ id }) => id));
    ids.filter((id) => !knownIds.has(id)).forEach((id) => invalid.add(`${kind}:${id}`));
  }
  return invalid;
}

/** Refuses a set that names a subject outside the organization. The caller
 * passes the grants it will INSERT, and no others.
 *
 * A SUBJECT IS CHECKED WHEN IT IS WRITTEN, NOT WHEN IT IS KEPT. Deleting a
 * workspace leaves its grant rows behind. The access editor hides a subject it
 * cannot name, and still sends that grant back (`namedAccessSubjects` in the
 * webapp). Checking a kept grant therefore refused every later edit of that
 * credential's audience. No row on screen explained the refusal.
 *
 * A stale grant gives nobody anything. `orgCredentialAccess` needs a resolved
 * active membership. A deleted workspace is never a caller's workspace. */
async function assertGrantSubjects(
  db: Db,
  orgId: string,
  grants: readonly OrgCredentialGrantView[],
): Promise<void> {
  const first = [...await invalidGrantSubjects(db, orgId, grants)][0];
  if (first !== undefined) {
    throw new HttpError(400, `grant subject is not in this organization: ${first}`);
  }
}

/** One audit row per org-credential machine read. There is no lease to hang
 * it on — an org credential has no connection row — so the event names the
 * machine, its workspace and its member directly. */
export async function recordOrgCredentialUse(
  runtime: CoreRuntime,
  input: {
    credentialId: string;
    name: string;
    workspaceId: string;
    machineId: string;
    principal: Principal;
  },
  now = Date.now(),
): Promise<void> {
  await rows(runtime.db, {
    q: `INSERT INTO credential_events (lease_id, event, detail, created_at)
        VALUES (NULL, 'minted', ?1, ?2)`,
    v: [
      JSON.stringify({
        org_credential: input.name,
        credential_id: input.credentialId,
        box_id: input.machineId,
        workspace_id: input.workspaceId,
        acting_principal: {
          userId: input.principal.id,
          membershipId: input.principal.membershipId,
        },
      }),
      now,
    ],
  });
}

/** The organization a session route names. "self" is the session's own; any
 * other id must BE that organization, or 404. Shared with grant-proposals.ts. */
export function requestedOrgId(context: CoreContext, principal: Principal): string {
  const requested = context.req.param("id");
  if (principal.orgId === null) throw new HttpError(404, "organization not found");
  if (requested !== "self" && requested !== principal.orgId) {
    throw new HttpError(404, "organization not found");
  }
  return principal.orgId;
}

export function callerFor(principal: Principal): OrgCredentialCaller {
  return { membershipId: principal.membershipId, orgRole: principal.role };
}
