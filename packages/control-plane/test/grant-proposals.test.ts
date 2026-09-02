import type {
  GrantChange,
  GrantProposalView,
  ListGrantProposalsResponse,
  ListOrgCredentialsResponse,
  ProposeGrantChangesResponse,
  ResolveGrantProposalResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRANT_PROPOSAL_TTL_MS } from "../core/grant-proposals.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  userSession,
  workspacePhoneHomeUrl,
} from "./helpers.js";

type Harness = ReturnType<typeof harness>;

function json(body: object, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function withCookie(cookie: string, init: RequestInit): RequestInit {
  return { ...init, headers: { ...init.headers, Cookie: cookie } };
}

function withToken(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } };
}

async function createWorkspaceWith(
  app: Harness["app"],
  cookie: string,
  members: { membershipId: string; role: "member" }[],
): Promise<WorkspaceView> {
  const created = await appRequest(
    app,
    "/workspaces",
    withCookie(cookie, json({ machineTypeId: "small", members })),
  );
  expect(created.status).toBe(201);
  return (await created.json<{ workspace: WorkspaceView }>()).workspace;
}

/** One member's machine credential, through the machine's own phone-home. */
async function machineToken(
  app: Harness["app"],
  providers: Harness["providers"],
  workspaceId: string,
  membershipId = "personal",
): Promise<string> {
  const url = await workspacePhoneHomeUrl(providers, workspaceId, membershipId);
  const ready = await appRequest(app, new URL(url).pathname, json({
    pub_key_ed25519: "ssh-ed25519 AAAAhost",
  }));
  expect(ready.status).toBe(200);
  return (await ready.json<{ access_token: string }>()).access_token;
}

async function storeOrgCredential(
  app: Harness["app"],
  cookie: string,
  name: string,
): Promise<void> {
  const stored = await appRequest(
    app,
    "/orgs/self/credentials",
    withCookie(cookie, json({ name, value: `${name}-value` }, "PUT")),
  );
  expect(stored.status).toBe(201);
}

async function grantsOf(
  app: Harness["app"],
  cookie: string,
): Promise<Record<string, GrantChange[] | ListOrgCredentialsResponse["credentials"][number]["grants"]>> {
  const listed = await appRequest(app, "/orgs/self/credentials", withCookie(cookie, {}));
  expect(listed.status).toBe(200);
  const { credentials } = await listed.json<ListOrgCredentialsResponse>();
  return Object.fromEntries(credentials.map(({ name, grants }) => [name, grants]));
}

async function propose(
  app: Harness["app"],
  token: string,
  changes: GrantChange[],
  reason = "the team needs it",
): Promise<Response> {
  return appRequest(
    app,
    "/agent/credentials/grant-proposals",
    withToken(token, json({ changes, reason })),
  );
}

async function proposed(
  app: Harness["app"],
  token: string,
  changes: GrantChange[],
  reason?: string,
): Promise<string> {
  const response = await propose(app, token, changes, reason);
  expect(response.status).toBe(201);
  const body = await response.json<ProposeGrantChangesResponse>();
  expect(body.state).toBe("pending");
  return body.id;
}

async function poll(
  app: Harness["app"],
  token: string,
  id: string,
): Promise<Response> {
  return appRequest(app, `/agent/grant-proposals/${id}`, withToken(token));
}

async function feed(
  app: Harness["app"],
  cookie: string,
): Promise<GrantProposalView[]> {
  const response = await appRequest(app, "/orgs/self/grant-proposals", withCookie(cookie, {}));
  expect(response.status).toBe(200);
  return (await response.json<ListGrantProposalsResponse>()).proposals;
}

async function resolve(
  app: Harness["app"],
  cookie: string,
  id: string,
  body: { approve: boolean; changes: GrantChange[] },
): Promise<Response> {
  return appRequest(app, `/orgs/self/grant-proposals/${id}/resolve`, withCookie(cookie, json(body)));
}

const add = (
  name: string,
  subjectKind: GrantChange["subjectKind"],
  subjectId: string | null,
  access: GrantChange["access"],
): GrantChange => ({ name, action: "add", subjectKind, subjectId, access });

const remove = (
  name: string,
  subjectKind: GrantChange["subjectKind"],
  subjectId: string | null,
  access: GrantChange["access"],
): GrantChange => ({ name, action: "remove", subjectKind, subjectId, access });

describe("grant proposals (plans/ORG-CREDENTIALS.md §7a)", () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    vi.useRealTimers();
  });

  it("propose → feed → resolve with edits → poll: what applied is what was approved", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const sharer = await sameOrgSession("sharer");
    const grantee = await sameOrgSession("grantee");
    const workspace = await createWorkspaceWith(app, admin, [
      { membershipId: sharer.membershipId, role: "member" },
      { membershipId: grantee.membershipId, role: "member" },
    ]);
    // The sharer creates both keys, so their creator grant is their authority.
    await storeOrgCredential(app, sharer.cookie, "KEY_A");
    await storeOrgCredential(app, sharer.cookie, "KEY_B");
    const token = await machineToken(app, providers, workspace.id, sharer.membershipId);

    const changes = [
      add("KEY_A", "workspace", workspace.id, "read"),
      add("KEY_A", "membership", grantee.membershipId, "write"),
      add("KEY_B", "org", null, "read"),
    ];
    const id = await proposed(app, token, changes, "CI and the grantee need these");

    // The feed: the acting member sees it, the admin sees it, a bystander
    // does not. The proposal carries the reason verbatim.
    const mine = await feed(app, sharer.cookie);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id,
      state: "pending",
      membershipId: sharer.membershipId,
      reason: "CI and the grantee need these",
      proposed: changes,
      applied: null,
    });
    expect((await feed(app, admin)).map((proposal) => proposal.id)).toEqual([id]);
    await expect(feed(app, grantee.cookie)).resolves.toEqual([]);
    // Meanwhile the agent's poll says: still pending.
    await expect(poll(app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ id, state: "pending", applied: null });

    // A bystander may not resolve it, and nothing changed.
    expect((await resolve(app, grantee.cookie, id, { approve: true, changes })).status).toBe(403);
    expect((await grantsOf(app, admin)).KEY_B).toEqual([
      { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
    ]);

    // The person edits before approving: KEY_B's org-wide share is skipped
    // and the grantee's write is downgraded to read.
    const edited = [
      add("KEY_A", "workspace", workspace.id, "read"),
      add("KEY_A", "membership", grantee.membershipId, "read"),
    ];
    const resolved = await resolve(app, sharer.cookie, id, { approve: true, changes: edited });
    expect(resolved.status).toBe(200);
    expect((await resolved.json<ResolveGrantProposalResponse>()).proposal).toMatchObject({
      id,
      state: "approved",
      applied: edited,
    });

    // The agent's poll returns exactly the edited set, not what it asked for.
    const polled = await poll(app, token, id);
    expect(polled.status).toBe(200);
    const view = await polled.json<GrantProposalView>();
    expect(view.state).toBe("approved");
    expect(view.applied).toEqual(edited);
    expect(view.proposed).toEqual(changes);

    // And the grants really changed — only as approved.
    const grants = await grantsOf(app, admin);
    expect(grants.KEY_A).toEqual([
      { subjectKind: "membership", subjectId: grantee.membershipId, access: "read" },
      { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
      { subjectKind: "workspace", subjectId: workspace.id, access: "read" },
    ]);
    expect(grants.KEY_B).toEqual([
      { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
    ]);
    // The replace helper wrote the audit rows: two approvals for KEY_A, none for KEY_B.
    const events = await env.DB.prepare(
      `SELECT detail FROM credential_events
       WHERE event = 'approved' AND detail LIKE '%org_credential_grant%'
         AND detail LIKE '%"credential_name":"KEY_A"%'`,
    ).all<{ detail: string }>();
    // The creator grant at create, then the two approved here.
    expect(events.results).toHaveLength(3);

    // Resolved means resolved: off the pending feed, and a second answer is a 409.
    await expect(feed(app, sharer.cookie)).resolves.toEqual([]);
    expect((await resolve(app, sharer.cookie, id, { approve: true, changes: edited })).status)
      .toBe(409);
    expect((await resolve(app, admin, id, { approve: false, changes: [] })).status).toBe(409);
  });

  it("commits a multi-credential approval as one transaction", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const workspace = await createWorkspace(app, admin);
    await storeOrgCredential(app, admin, "KEY_A");
    await storeOrgCredential(app, admin, "KEY_B");
    const token = await machineToken(app, providers, workspace.id);
    const changes = [
      add("KEY_A", "workspace", workspace.id, "read"),
      add("KEY_B", "workspace", workspace.id, "read"),
    ];
    const id = await proposed(app, token, changes);

    await env.DB.prepare(`CREATE TRIGGER fail_key_b_grant
      BEFORE INSERT ON org_credential_grants
      WHEN (SELECT name FROM org_credentials WHERE id = NEW.credential_id) = 'KEY_B'
      BEGIN SELECT RAISE(ABORT, 'forced KEY_B failure'); END`).run();
    const failed = await resolve(app, admin, id, { approve: true, changes });
    expect(failed.status).toBe(500);
    await env.DB.prepare("DROP TRIGGER fail_key_b_grant").run();

    const grants = await grantsOf(app, admin);
    const creatorGrant = [
      { subjectKind: "membership", subjectId: "personal", access: "write" },
    ];
    expect(grants.KEY_A).toEqual(creatorGrant);
    expect(grants.KEY_B).toEqual(creatorGrant);
    await expect(poll(app, token, id).then((response) => response.json()))
      .resolves.toMatchObject({ state: "pending", applied: null });
  });

  it("deny changes nothing, and an org admin may answer for the member", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const sharer = await sameOrgSession("sharer");
    const workspace = await createWorkspaceWith(app, admin, [
      { membershipId: sharer.membershipId, role: "member" },
    ]);
    await storeOrgCredential(app, sharer.cookie, "KEY_A");
    const token = await machineToken(app, providers, workspace.id, sharer.membershipId);
    const changes = [add("KEY_A", "org", null, "read")];
    const id = await proposed(app, token, changes);

    const denied = await resolve(app, admin, id, { approve: false, changes });
    expect(denied.status).toBe(200);
    expect((await denied.json<ResolveGrantProposalResponse>()).proposal).toMatchObject({
      state: "denied",
      applied: null,
    });
    await expect(poll(app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ state: "denied", applied: null });
    expect((await grantsOf(app, admin)).KEY_A).toEqual([
      { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
    ]);
    expect((await resolve(app, sharer.cookie, id, { approve: true, changes })).status).toBe(409);
  });

  it("drops a credential revoked meanwhile from applied, and removes exactly what is named", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const sharer = await sameOrgSession("sharer");
    const workspace = await createWorkspaceWith(app, admin, [
      { membershipId: sharer.membershipId, role: "member" },
    ]);
    await storeOrgCredential(app, sharer.cookie, "KEY_A");
    await storeOrgCredential(app, sharer.cookie, "KEY_B");
    // KEY_A already carries a workspace read the agent wants gone, plus a
    // write it wants to keep — the removal names the read alone.
    expect((await appRequest(app, "/orgs/self/credentials/KEY_A/grants", withCookie(admin, json({
      grants: [
        { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
        { subjectKind: "workspace", subjectId: workspace.id, access: "read" },
        { subjectKind: "org", subjectId: null, access: "read" },
      ],
    }, "PUT")))).status).toBe(200);
    const token = await machineToken(app, providers, workspace.id, sharer.membershipId);

    const changes = [
      remove("KEY_A", "workspace", workspace.id, "read"),
      // Names a grant that does not exist at that access: a no-op.
      remove("KEY_A", "org", null, "write"),
      add("KEY_B", "org", null, "read"),
    ];
    const id = await proposed(app, token, changes);
    // KEY_B goes away before the person answers.
    expect((await appRequest(app, "/orgs/self/credentials/KEY_B", {
      method: "DELETE", headers: { Cookie: admin },
    })).status).toBe(204);

    const resolved = await resolve(app, sharer.cookie, id, { approve: true, changes });
    expect(resolved.status).toBe(200);
    expect((await resolved.json<ResolveGrantProposalResponse>()).proposal.applied).toEqual([
      remove("KEY_A", "workspace", workspace.id, "read"),
    ]);
    expect((await grantsOf(app, admin)).KEY_A).toEqual([
      { subjectKind: "membership", subjectId: sharer.membershipId, access: "write" },
      { subjectKind: "org", subjectId: null, access: "read" },
    ]);
  });

  it("refuses a proposal past the member's authority with a 403 naming the changes", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("plain-member");
    const workspace = await createWorkspaceWith(app, admin, [
      { membershipId: member.membershipId, role: "member" },
    ]);
    // The admin's key: the member holds no grant on it at all.
    await storeOrgCredential(app, admin, "ADMIN_KEY");
    // The member's own key: within their authority.
    await storeOrgCredential(app, member.cookie, "MY_KEY");
    const token = await machineToken(app, providers, workspace.id, member.membershipId);

    const refused = await propose(app, token, [
      add("MY_KEY", "workspace", workspace.id, "read"),
      add("ADMIN_KEY", "workspace", workspace.id, "read"),
      remove("NO_SUCH_KEY", "org", null, "read"),
    ]);
    expect(refused.status).toBe(403);
    const { error } = await refused.json<{ error: string }>();
    expect(error).toContain("ADMIN_KEY add workspace:" + workspace.id + " read");
    expect(error).toContain("NO_SUCH_KEY remove org read");
    expect(error).not.toContain("MY_KEY");
    // The refused changes are somebody else's to grant, and the agent is
    // told where that ask goes instead of only "narrow and retry".
    expect(error).toContain("POST /agent/credentials/<name>/token");
    // Nothing was stored: the feed is empty for member and admin alike.
    await expect(feed(app, member.cookie)).resolves.toEqual([]);
    await expect(feed(app, admin)).resolves.toEqual([]);

    // Read is not write: an org-wide read grant does not make the key proposable.
    expect((await appRequest(app, "/orgs/self/credentials/ADMIN_KEY/grants", withCookie(admin, json({
      grants: [
        { subjectKind: "membership", subjectId: "personal", access: "write" },
        { subjectKind: "org", subjectId: null, access: "read" },
      ],
    }, "PUT")))).status).toBe(200);
    expect((await propose(app, token, [add("ADMIN_KEY", "org", null, "write")])).status).toBe(403);

    // The same check guards the resolve: a proposal within authority at
    // propose time is refused at approve time once that authority is gone.
    const id = await proposed(app, token, [add("MY_KEY", "org", null, "read")]);
    expect((await appRequest(app, "/orgs/self/credentials/MY_KEY/grants", withCookie(admin, json({
      grants: [{ subjectKind: "membership", subjectId: "personal", access: "write" }],
    }, "PUT")))).status).toBe(200);
    const late = await resolve(app, member.cookie, id, {
      approve: true, changes: [add("MY_KEY", "org", null, "read")],
    });
    expect(late.status).toBe(403);
    const lateError = (await late.json<{ error: string }>()).error;
    expect(lateError).toContain("MY_KEY add org read");
    // A person reads the approver's refusal; the agent's escalation hint
    // would only confuse them.
    expect(lateError).not.toContain("/agent/credentials/");
    // Still pending: the admin, whose authority covers it, can approve.
    expect((await resolve(app, admin, id, {
      approve: true, changes: [add("MY_KEY", "org", null, "read")],
    })).status).toBe(200);
    expect((await grantsOf(app, admin)).MY_KEY).toEqual([
      { subjectKind: "membership", subjectId: "personal", access: "write" },
      { subjectKind: "org", subjectId: null, access: "read" },
    ]);

    // Malformed asks are 400s, not proposals.
    expect((await propose(app, token, [])).status).toBe(400);
    expect((await appRequest(app, "/agent/credentials/grant-proposals", withToken(token, json({
      changes: [{ name: "MY_KEY", action: "share", subjectKind: "org", subjectId: null, access: "read" }],
      reason: "x",
    })))).status).toBe(400);
    expect((await appRequest(app, "/agent/credentials/grant-proposals", withToken(token, json({
      changes: [add("MY_KEY", "org", null, "read")],
    })))).status).toBe(400);
  });

  it("refuses a proposal naming a subject outside the organization, with a 400 naming it", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const gone = await sameOrgSession("gone-member", "member", "disabled");
    await userSession("stranger");
    const workspace = await createWorkspace(app, admin);
    await storeOrgCredential(app, admin, "KEY_A");
    const token = await machineToken(app, providers, workspace.id);

    // The same rule the grant write enforces: a disabled membership and a
    // membership in another org are not subjects here; the workspace is.
    const refused = await propose(app, token, [
      add("KEY_A", "workspace", workspace.id, "read"),
      add("KEY_A", "membership", gone.membershipId, "read"),
      add("KEY_A", "membership", "stranger-membership", "write"),
      add("KEY_A", "workspace", "no-such-workspace", "read"),
    ]);
    expect(refused.status).toBe(400);
    const { error } = await refused.json<{ error: string }>();
    expect(error).toContain(`KEY_A add membership:${gone.membershipId} read`);
    expect(error).toContain("KEY_A add membership:stranger-membership write");
    expect(error).toContain("KEY_A add workspace:no-such-workspace read");
    expect(error).not.toContain(`workspace:${workspace.id}`);
    // Nothing was filed.
    await expect(feed(app, admin)).resolves.toEqual([]);
  });

  it("drops a subject that went invalid between propose and resolve, applying the rest", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const leaver = await sameOrgSession("leaver");
    const workspace = await createWorkspace(app, admin);
    await storeOrgCredential(app, admin, "KEY_A");
    await storeOrgCredential(app, admin, "KEY_B");
    // KEY_B already holds a grant for the leaver: a kept grant that the
    // store would refuse to re-validate once they are gone.
    expect((await appRequest(app, "/orgs/self/credentials/KEY_B/grants", withCookie(admin, json({
      grants: [
        { subjectKind: "membership", subjectId: "personal", access: "write" },
        { subjectKind: "membership", subjectId: leaver.membershipId, access: "read" },
      ],
    }, "PUT")))).status).toBe(200);
    const token = await machineToken(app, providers, workspace.id);

    const changes = [
      add("KEY_A", "workspace", workspace.id, "read"),
      add("KEY_A", "membership", leaver.membershipId, "read"),
      add("KEY_B", "org", null, "read"),
    ];
    const id = await proposed(app, token, changes);
    // The leaver is disabled before the person answers.
    await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = ?1")
      .bind(leaver.membershipId).run();

    const resolved = await resolve(app, admin, id, { approve: true, changes });
    expect(resolved.status).toBe(200);
    const { proposal } = await resolved.json<ResolveGrantProposalResponse>();
    // The leaver's add is dropped; KEY_B is skipped whole, because its kept
    // grant would have refused the write. KEY_A's workspace read applies.
    expect(proposal).toMatchObject({
      state: "approved",
      applied: [add("KEY_A", "workspace", workspace.id, "read")],
    });
    const grants = await grantsOf(app, admin);
    expect(grants.KEY_A).toEqual([
      { subjectKind: "membership", subjectId: "personal", access: "write" },
      { subjectKind: "workspace", subjectId: workspace.id, access: "read" },
    ]);
    expect(grants.KEY_B).toEqual([
      { subjectKind: "membership", subjectId: leaver.membershipId, access: "read" },
      { subjectKind: "membership", subjectId: "personal", access: "write" },
    ]);
    await expect(poll(app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ state: "approved", applied: proposal.applied });
  });

  it("expires a proposal nobody answered within the TTL", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const workspace = await createWorkspace(app, admin);
    await storeOrgCredential(app, admin, "KEY_A");
    const token = await machineToken(app, providers, workspace.id);
    const changes = [add("KEY_A", "workspace", workspace.id, "read")];

    // The proposal is filed just over a TTL ago. Only the clock is faked, and
    // only for the propose: the machine token was minted at real time, so
    // reading with the clock run forward would expire the TOKEN before the
    // proposal, which is a different fact than the one this test pins.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now - GRANT_PROPOSAL_TTL_MS - 1);
    const id = await proposed(app, token, changes);
    vi.useRealTimers();

    await expect(poll(app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ id, state: "expired", applied: null });
    await expect(feed(app, admin)).resolves.toEqual([]);
    expect((await resolve(app, admin, id, { approve: true, changes })).status).toBe(409);
    expect((await grantsOf(app, admin)).KEY_A).toEqual([
      { subjectKind: "membership", subjectId: "personal", access: "write" },
    ]);
  });

  it("keeps a proposal inside its organization", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const workspace = await createWorkspace(app, admin);
    await storeOrgCredential(app, admin, "KEY_A");
    const token = await machineToken(app, providers, workspace.id);
    const id = await proposed(app, token, [add("KEY_A", "workspace", workspace.id, "read")]);

    // A machine in another organization polls the same id and gets nothing.
    const stranger = await userSession("stranger");
    const theirs = await createWorkspace(app, stranger);
    const strangerToken = await machineToken(app, providers, theirs.id, "stranger-membership");
    expect((await poll(app, strangerToken, id)).status).toBe(404);
    // Their admin session cannot see it, resolve it, or name our org.
    await expect(feed(app, stranger)).resolves.toEqual([]);
    expect((await resolve(app, stranger, id, { approve: true, changes: [] })).status).toBe(404);
    expect((await appRequest(app, "/orgs/personal/grant-proposals", withCookie(stranger, {})))
      .status).toBe(404);
    // An id nobody issued reads the same as another org's.
    expect((await poll(app, token, "no-such-proposal")).status).toBe(404);
    // A recycled runtime (another isolate, say) reads the same row, so the
    // proposal is still there — this is what the row is for.
    await expect(poll(harness().app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ id, state: "pending" });
    // Ours is untouched.
    await expect(poll(app, token, id).then((r) => r.json()))
      .resolves.toMatchObject({ state: "pending" });
  });
});
