import type {
  ImportOrgCredentialsResponse,
  ListOrgCredentialsResponse,
  PutOrgCredentialResponse,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { orgCredentialAccess } from "../core/org-credentials.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

function json(body: object, method = "PUT"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function grant(
  subjectKind: "org" | "workspace" | "membership",
  subjectId: string | null,
  access: "read" | "write",
) {
  return {
    id: "grant",
    credential_id: "credential",
    subject_kind: subjectKind,
    subject_id: subjectId,
    access,
  } as const;
}

describe("orgCredentialAccess (§6)", () => {
  const member = { membershipId: "m1", orgRole: "member" as const };

  it("refuses a caller with no resolved active membership, whatever grants exist", () => {
    expect(orgCredentialAccess(
      { grants: [grant("org", null, "write")] },
      { membershipId: null, orgRole: null },
    )).toEqual({ read: false, write: false });
  });

  it("gives an org admin read and write with zero grants", () => {
    expect(orgCredentialAccess(
      { grants: [] },
      { membershipId: "m1", orgRole: "admin" },
    )).toEqual({ read: true, write: true });
  });

  it("grades org-wide grants: read is read, write is both", () => {
    expect(orgCredentialAccess({ grants: [grant("org", null, "read")] }, member))
      .toEqual({ read: true, write: false });
    expect(orgCredentialAccess({ grants: [grant("org", null, "write")] }, member))
      .toEqual({ read: true, write: true });
  });

  it("matches a workspace grant only in that workspace", () => {
    const credential = { grants: [grant("workspace", "ws1", "read")] };
    expect(orgCredentialAccess(credential, { ...member, workspaceId: "ws1" }))
      .toEqual({ read: true, write: false });
    expect(orgCredentialAccess(credential, { ...member, workspaceId: "ws2" }))
      .toEqual({ read: false, write: false });
    // A session caller stands in no workspace, so a workspace grant is not theirs.
    expect(orgCredentialAccess(credential, member))
      .toEqual({ read: false, write: false });
  });

  it("follows a membership grant onto any of the member's contexts", () => {
    const credential = { grants: [grant("membership", "m1", "write")] };
    expect(orgCredentialAccess(credential, member)).toEqual({ read: true, write: true });
    expect(orgCredentialAccess(credential, { ...member, workspaceId: "anywhere" }))
      .toEqual({ read: true, write: true });
    expect(orgCredentialAccess(credential, { membershipId: "m2", orgRole: "member" }))
      .toEqual({ read: false, write: false });
  });
});

describe("org credentials: session plane (§7)", () => {
  beforeEach(resetDatabase);

  it("stores, lists, rotates and revokes; comments are tri-state", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    const created = await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "STRIPE_API_KEY", value: "sk_v1", comment: "test-mode key" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const view = (await created.json<PutOrgCredentialResponse>()).credential;
    expect(view).toMatchObject({
      name: "STRIPE_API_KEY",
      comment: "test-mode key",
      createdByMembershipId: "personal",
      // The creator's own write grant, written in the same transaction (§12).
      grants: [{ subjectKind: "membership", subjectId: "personal", access: "write" }],
    });
    // A value never comes back out of the store.
    expect(JSON.stringify(view)).not.toContain("sk_v1");

    // Rotate with no comment: the secret changes, what it is for does not.
    const rotated = await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "STRIPE_API_KEY", value: "sk_v2" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(rotated.status).toBe(200);
    expect((await rotated.json<PutOrgCredentialResponse>()).credential).toMatchObject({
      comment: "test-mode key",
      grants: [{ subjectKind: "membership", subjectId: "personal", access: "write" }],
    });
    // The revoked row stays as rotation history.
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM org_credentials WHERE name = 'STRIPE_API_KEY'",
    ).first<number>("count")).toBe(2);

    // An explicit null clears the comment.
    const cleared = await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "STRIPE_API_KEY", value: "sk_v3", comment: null }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect((await cleared.json<PutOrgCredentialResponse>()).credential.comment).toBeNull();

    expect((await appRequest(app, "/orgs/self/credentials/STRIPE_API_KEY", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    await expect(appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toEqual({ credentials: [] });
    // The revoke deleted the ACL rows; the audit lives in credential_events.
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM org_credential_grants",
    ).first<number>("count")).toBe(0);
    expect((await appRequest(app, "/orgs/self/credentials/STRIPE_API_KEY", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("gates visibility on read, grant edits on write, and lets any member create", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("plain-member");

    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "ADMIN_ONLY_KEY", value: "secret-a" }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(201);

    // No grant covers the member on the session plane, so they see nothing.
    await expect(appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: member.cookie },
    }).then((response) => response.json())).resolves.toEqual({ credentials: [] });

    // An org-wide read grant makes them a plain reader: visible, grants [].
    expect((await appRequest(app, "/orgs/self/credentials/ADMIN_ONLY_KEY/grants", {
      ...json({ grants: [
        { subjectKind: "org", subjectId: null, access: "read" },
        { subjectKind: "membership", subjectId: "personal", access: "write" },
      ] }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(200);
    const listed = await appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: member.cookie },
    });
    const { credentials } = await listed.json<ListOrgCredentialsResponse>();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ name: "ADMIN_ONLY_KEY", grants: [] });

    // Read is not write: rotate, grant edits and revoke all refuse.
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "ADMIN_ONLY_KEY", value: "overwritten" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, "/orgs/self/credentials/ADMIN_ONLY_KEY/grants", {
      ...json({ grants: [] }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, "/orgs/self/credentials/ADMIN_ONLY_KEY", {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    // A membership write grant turns the member into a writer.
    expect((await appRequest(app, "/orgs/self/credentials/ADMIN_ONLY_KEY/grants", {
      ...json({ grants: [
        { subjectKind: "membership", subjectId: member.membershipId, access: "write" },
      ] }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "ADMIN_ONLY_KEY", value: "rotated-by-member" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(200);

    // Create is open to any active member (§12), and the org admin sees every
    // credential without holding a grant row.
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "MEMBER_MADE_KEY", value: "member-value" }),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    const adminList = await appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: admin },
    });
    expect((await adminList.json<ListOrgCredentialsResponse>()).credentials
      .map(({ name }) => name)).toEqual(["ADMIN_ONLY_KEY", "MEMBER_MADE_KEY"]);
  });

  it("filters a workspace credential list on the server", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("workspace-reader");
    const createWorkspace = async (members: object[]) => {
      const response = await appRequest(app, "/workspaces", {
        ...json({ machineTypeId: "small", members }, "POST"),
        headers: { Cookie: admin, "Content-Type": "application/json" },
      });
      return (await response.json<{ workspace: { id: string } }>()).workspace.id;
    };
    const target = await createWorkspace([{ membershipId: member.membershipId, role: "member" }]);
    const elsewhere = await createWorkspace([]);

    for (const name of ["IN_WORKSPACE", "ORG_WIDE", "ELSEWHERE"]) {
      expect((await appRequest(app, "/orgs/self/credentials", {
        ...json({ name, value: `${name}-value` }),
        headers: { Cookie: admin, "Content-Type": "application/json" },
      })).status).toBe(201);
    }
    const setGrants = async (name: string, grants: object[]) => appRequest(
      app,
      `/orgs/self/credentials/${name}/grants`,
      {
        ...json({ grants: [
          ...grants,
          { subjectKind: "membership", subjectId: "personal", access: "write" },
        ] }),
        headers: { Cookie: admin, "Content-Type": "application/json" },
      },
    );
    expect((await setGrants("IN_WORKSPACE", [
      { subjectKind: "workspace", subjectId: target, access: "read" },
    ])).status).toBe(200);
    expect((await setGrants("ORG_WIDE", [
      { subjectKind: "org", subjectId: null, access: "read" },
    ])).status).toBe(200);
    expect((await setGrants("ELSEWHERE", [
      { subjectKind: "workspace", subjectId: elsewhere, access: "read" },
    ])).status).toBe(200);

    const scoped = await appRequest(
      app,
      `/orgs/self/credentials?workspaceId=${target}`,
      { headers: { Cookie: member.cookie } },
    );
    expect(scoped.status).toBe(200);
    expect((await scoped.json<ListOrgCredentialsResponse>()).credentials.map(({ name }) => name))
      .toEqual(["IN_WORKSPACE", "ORG_WIDE"]);
    const sessionList = await appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: member.cookie },
    });
    expect((await sessionList.json<ListOrgCredentialsResponse>()).credentials.map(({ name }) => name))
      .toEqual(["ORG_WIDE"]);
    expect((await appRequest(
      app,
      `/orgs/self/credentials?workspaceId=${elsewhere}`,
      { headers: { Cookie: member.cookie } },
    )).status).toBe(403);
  });

  it("replaces the grant set atomically, validates subjects, and writes events", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const teammate = await sameOrgSession("grantee");
    const gone = await sameOrgSession("gone-member", "member", "disabled");
    const created = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspaceId = (await created.json<{ workspace: { id: string } }>()).workspace.id;

    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "SHARED_KEY", value: "shared-value" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(201);

    // Subjects validate at write time: an unknown workspace and a non-active
    // membership both refuse the whole set.
    expect((await appRequest(app, "/orgs/self/credentials/SHARED_KEY/grants", {
      ...json({ grants: [{ subjectKind: "workspace", subjectId: "nope", access: "read" }] }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await appRequest(app, "/orgs/self/credentials/SHARED_KEY/grants", {
      ...json({ grants: [
        { subjectKind: "membership", subjectId: gone.membershipId, access: "read" },
      ] }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);
    // The same subject twice is a malformed set, not a coin toss.
    expect((await appRequest(app, "/orgs/self/credentials/SHARED_KEY/grants", {
      ...json({ grants: [
        { subjectKind: "org", subjectId: null, access: "read" },
        { subjectKind: "org", subjectId: null, access: "write" },
      ] }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);

    const replaced = await appRequest(app, "/orgs/self/credentials/SHARED_KEY/grants", {
      ...json({ grants: [
        { subjectKind: "workspace", subjectId: workspaceId, access: "read" },
        { subjectKind: "membership", subjectId: teammate.membershipId, access: "write" },
      ] }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(replaced.status).toBe(200);
    const { credential } = await replaced.json<PutOrgCredentialResponse>();
    // Grants come back ordered by subject, not by insertion.
    expect(credential.grants).toEqual([
      { subjectKind: "membership", subjectId: teammate.membershipId, access: "write" },
      { subjectKind: "workspace", subjectId: workspaceId, access: "read" },
    ]);

    // Every add and remove is audited: the creator grant (approved at create,
    // revoked by the replace) and the two new grants (approved).
    const events = await env.DB.prepare(
      `SELECT event, detail FROM credential_events
       WHERE detail LIKE '%org_credential_grant%' ORDER BY id`,
    ).all<{ event: string; detail: string }>();
    const parsed = events.results.map(({ event, detail }) => ({
      event,
      // SAFETY: this test wrote every row it reads, all through
      // grantEventDetail, which serializes a JSON object.
      ...(JSON.parse(detail) as { subject_kind: string; access: string }),
    }));
    expect(parsed.map(({ event, subject_kind, access }) => [event, subject_kind, access]))
      .toEqual([
        ["approved", "membership", "write"],
        ["revoked", "membership", "write"],
        ["approved", "workspace", "read"],
        ["approved", "membership", "write"],
      ]);
  });

  it("enforces the caps and the name rule", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const headers = { Cookie: cookie, "Content-Type": "application/json" };

    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "1BAD_NAME", value: "x" }), headers,
    })).status).toBe(400);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "TOO_BIG", value: "x".repeat(8 * 1024 + 1) }), headers,
    })).status).toBe(400);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "TWO_LINES", value: "x", comment: "a\nb" }), headers,
    })).status).toBe(400);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "LONG_COMMENT", value: "x", comment: "c".repeat(257) }), headers,
    })).status).toBe(400);

    // 200 live credentials is the org ceiling; the 201st create refuses and a
    // rotate of a live name still passes.
    const now = Date.now();
    const statements = [];
    for (let index = 0; index < 200; index += 1) {
      statements.push(env.DB.prepare(
        `INSERT INTO org_credentials
         (id, org_id, name, ciphertext, created_by_membership_id, created_at, updated_at)
         VALUES (?1, 'personal', ?2, 'sealed', 'personal', ?3, ?3)`,
      ).bind(`cap-${String(index)}`, `CAP_KEY_${String(index)}`, now));
    }
    await env.DB.batch(statements);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "ONE_TOO_MANY", value: "x" }), headers,
    })).status).toBe(409);
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "CAP_KEY_0", value: "rotated" }), headers,
    })).status).toBe(200);

    // More than 100 grants on one credential refuses.
    const grants = [...Array(101).keys()].map((index) => ({
      subjectKind: "membership",
      subjectId: `m-${String(index)}`,
      access: "read",
    }));
    expect((await appRequest(app, "/orgs/self/credentials/CAP_KEY_0/grants", {
      ...json({ grants }), headers,
    })).status).toBe(400);
  });

  it("imports a dotenv at org scope, refusing per line and per authority", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("importer");

    // A key the member may not rotate: only the admin's creator grant covers it.
    expect((await appRequest(app, "/orgs/self/credentials", {
      ...json({ name: "LOCKED_KEY", value: "locked", comment: "keep this comment" }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(201);

    const text = [
      "# comment line",
      "LOCKED_KEY=stolen",
      "NEW_KEY=fresh-value",
      "export QUOTED='wrapped value'",
      "BROKEN_LINE",
      "EMPTY=",
    ].join("\n");

    // The dry run reports what the real import will do, and writes nothing.
    const preview = await appRequest(app, "/orgs/self/credentials/dotenv", {
      ...json({ text, dryRun: true }, "POST"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect(preview.status).toBe(200);
    const previewed = await preview.json<ImportOrgCredentialsResponse>();
    expect(previewed.results).toEqual([
      { name: "LOCKED_KEY", line: 2, outcome: "refused", reason: "write access to LOCKED_KEY required" },
      { name: "NEW_KEY", line: 3, outcome: "stored" },
      { name: "QUOTED", line: 4, outcome: "stored" },
      { name: "BROKEN_LINE", line: 5, outcome: "refused", reason: "not a NAME=value line" },
      { name: "EMPTY", line: 6, outcome: "refused", reason: "empty value" },
    ]);
    expect(previewed.linesRead).toBe(6);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM org_credentials WHERE revoked_at IS NULL",
    ).first<number>("count")).toBe(1);

    const imported = await appRequest(app, "/orgs/self/credentials/dotenv", {
      ...json({ text }, "POST"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect((await imported.json<ImportOrgCredentialsResponse>()).results
      .map(({ outcome }) => outcome))
      .toEqual(["refused", "stored", "stored", "refused", "refused"]);

    // A re-run of the same file is idempotent, not a wave of rotations.
    const again = await appRequest(app, "/orgs/self/credentials/dotenv", {
      ...json({ text }, "POST"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    });
    expect((await again.json<ImportOrgCredentialsResponse>()).results
      .map(({ outcome }) => outcome))
      .toEqual(["refused", "unchanged", "unchanged", "refused", "refused"]);

    // The locked key kept its value and its comment; the importer's keys carry
    // their creator grant.
    const adminList = await appRequest(app, "/orgs/self/credentials", {
      headers: { Cookie: admin },
    });
    const { credentials } = await adminList.json<ListOrgCredentialsResponse>();
    expect(credentials.find(({ name }) => name === "LOCKED_KEY")).toMatchObject({
      comment: "keep this comment",
    });
    expect(credentials.find(({ name }) => name === "NEW_KEY")?.grants).toEqual([
      { subjectKind: "membership", subjectId: member.membershipId, access: "write" },
    ]);
  });

  it("refuses another organization's id outright", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    expect((await appRequest(app, "/orgs/somebody-else/credentials", {
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });
});
