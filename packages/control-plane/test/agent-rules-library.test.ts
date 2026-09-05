import type {
  AgentRulesResponse,
  AgentRuleView,
  ListAgentRulesResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RULE_CONTENT_MAX_BYTES,
  AGENT_RULES_DOC,
  BUILT_IN_AGENT_RULE_NAME,
} from "../core/agent-rules.js";
import {
  appRequest,
  boxTokenFor,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  userSession,
  type FakeProviders,
} from "./helpers.js";

function json(body: object, method = "PUT") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface TestApp {
  request(
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: Record<string, unknown>,
  ): Promise<Response>;
}

async function putRule(
  app: TestApp,
  cookie: string,
  id: string,
  body: object,
): Promise<Response> {
  return appRequest(app, `/agent-rules/${id}`, {
    ...json(body),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
}

async function listRules(app: TestApp, cookie: string): Promise<AgentRuleView[]> {
  const response = await appRequest(app, "/agent-rules", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return (await response.json<ListAgentRulesResponse>()).rules;
}

describe("agent rule library", () => {
  beforeEach(resetDatabase);

  it("lists the built-in doc, upserts, renames, and rejects bad input", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    const initial = await listRules(app, cookie);
    expect(initial).toEqual([
      {
        id: null,
        name: BUILT_IN_AGENT_RULE_NAME,
        content: AGENT_RULES_DOC,
        updatedAt: null,
        builtIn: true,
      },
    ]);

    const created = await putRule(app, cookie, "rule-1", {
      name: "House rules",
      content: "# House rules\n",
    });
    expect(created.status).toBe(201);
    const rule = (await created.json<{ rule: AgentRuleView }>()).rule;
    expect(rule).toMatchObject({ id: "rule-1", name: "House rules", builtIn: false });
    expect(rule.updatedAt).toBeTypeOf("number");

    // A rename is the same PUT: the id is stable, the name is replaced.
    const renamed = await putRule(app, cookie, "rule-1", {
      name: "Team rules",
      content: "# Team rules\n",
    });
    expect(renamed.status).toBe(200);
    const listed = await listRules(app, cookie);
    expect(listed.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: null, name: BUILT_IN_AGENT_RULE_NAME },
      { id: "rule-1", name: "Team rules" },
    ]);

    // Two rules may not share a name inside one org.
    expect((await putRule(app, cookie, "rule-2", {
      name: "Team rules",
      content: "# clash\n",
    })).status).toBe(409);

    const invalid = [
      { name: "", content: "# x\n" },
      { name: "   ", content: "# x\n" },
      { name: "x".repeat(121), content: "# x\n" },
      { name: "ok", content: "" },
      { name: "ok", content: "   \n" },
      { name: "ok", content: "x".repeat(AGENT_RULE_CONTENT_MAX_BYTES + 1) },
      { name: 7, content: "# x\n" },
      { name: "ok", content: 7 },
      // The built-in doc is a synthetic row with no id, so UNIQUE(org_id, name)
      // cannot stop a stored rule from claiming its label; the name is reserved
      // here instead, or the picker shows two options with one name.
      { name: BUILT_IN_AGENT_RULE_NAME, content: "# mine\n" },
      { name: ` ${BUILT_IN_AGENT_RULE_NAME} `, content: "# mine\n" },
    ];
    for (const candidate of invalid) {
      const response = await putRule(app, cookie, "rule-bad", candidate);
      expect(response.status, JSON.stringify(candidate).slice(0, 80)).toBe(400);
    }
    // A name that merely contains it is fine.
    expect((await putRule(app, cookie, "rule-ok", {
      name: `${BUILT_IN_AGENT_RULE_NAME} (fork)`,
      content: "# mine\n",
    })).status).toBe(201);
    expect((await listRules(app, cookie)).filter(
      ({ name }) => name === BUILT_IN_AGENT_RULE_NAME,
    )).toHaveLength(1);
  });

  // The box refuses to install a document larger than the same cap on the same
  // quantity — the UTF-8 byte length of `content`. If this route stored more,
  // the picker would show a rule selected that no box could ever apply.
  it("caps stored content by UTF-8 bytes, at the same boundary the box uses", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    // Exactly at the cap, all ASCII: stored.
    expect((await putRule(app, cookie, "rule-edge", {
      name: "At the cap",
      content: "x".repeat(AGENT_RULE_CONTENT_MAX_BYTES),
    })).status).toBe(201);

    // One byte over: refused.
    expect((await putRule(app, cookie, "rule-over", {
      name: "Over the cap",
      content: "x".repeat(AGENT_RULE_CONTENT_MAX_BYTES + 1),
    })).status).toBe(400);

    // Non-ASCII is measured in bytes, not UTF-16 units: "é" is two bytes, so
    // half the cap in characters is exactly the cap in bytes and still fits,
    // while one more character is one byte too many.
    const twoByte = "é";
    expect(new TextEncoder().encode(twoByte).byteLength).toBe(2);
    expect((await putRule(app, cookie, "rule-utf8", {
      name: "Accented, at the cap",
      content: twoByte.repeat(AGENT_RULE_CONTENT_MAX_BYTES / 2),
    })).status).toBe(201);
    expect((await putRule(app, cookie, "rule-utf8-over", {
      name: "Accented, over the cap",
      content: twoByte.repeat(AGENT_RULE_CONTENT_MAX_BYTES / 2 + 1),
    })).status).toBe(400);

    // A document at the cap whose JSON envelope is far larger than the cap —
    // every byte escapes to two — is still stored. Capping the envelope instead
    // of the content would have refused it.
    const escaped = "\n".repeat(AGENT_RULE_CONTENT_MAX_BYTES);
    expect(JSON.stringify(escaped).length).toBeGreaterThan(AGENT_RULE_CONTENT_MAX_BYTES * 2);
    expect((await putRule(app, cookie, "rule-escaped", {
      name: "Newlines, at the cap",
      content: `# rules${escaped}`.slice(0, AGENT_RULE_CONTENT_MAX_BYTES),
    })).status).toBe(201);
  });

  it("scopes rules to the org and lets any active member author them", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("member");
    const outsider = await userSession("outsider");

    expect((await putRule(app, owner, "rule-1", {
      name: "House rules",
      content: "# House rules\n",
    })).status).toBe(201);

    // A plain member — no admin gate — may read and write the shared library.
    expect((await listRules(app, member.cookie)).map(({ id }) => id)).toEqual([null, "rule-1"]);
    expect((await putRule(app, member.cookie, "rule-2", {
      name: "Member rules",
      content: "# Member rules\n",
    })).status).toBe(201);

    // Another org sees only the built-in and cannot touch the first org's rule.
    expect((await listRules(app, outsider)).map(({ id }) => id)).toEqual([null]);
    expect((await putRule(app, outsider, "rule-1", {
      name: "Hijack",
      content: "# nope\n",
    })).status).toBe(404);
    expect((await appRequest(app, "/agent-rules/rule-1", {
      method: "DELETE",
      headers: { Cookie: outsider },
    })).status).toBe(404);
    expect((await listRules(app, owner)).map(({ name }) => name)).toEqual([
      BUILT_IN_AGENT_RULE_NAME,
      "House rules",
      "Member rules",
    ]);

    // Signed out is 401, not a silent empty library.
    expect((await appRequest(app, "/agent-rules")).status).toBe(401);
  });

  // A workspace is its own template now, so the clone source is what a create
  // inherits a rule from (plans/MEMBER-MACHINES.md §0).
  it("resolves the workspace rule ahead of the clone source's rule and the built-in", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putRule(app, cookie, "rule-template", {
      name: "Source rules",
      content: "# from the template\n",
    });
    await putRule(app, cookie, "rule-workspace", {
      name: "Workspace rules",
      content: "# from the workspace\n",
    });

    const create = async (body: object): Promise<WorkspaceView> => {
      const response = await appRequest(app, "/workspaces", {
        ...json(body, "POST"),
        headers: { Cookie: cookie, "Content-Type": "application/json" },
      });
      expect(response.status).toBe(201);
      return (await response.json<{ workspace: WorkspaceView }>()).workspace;
    };
    // Phone-home mints a box token once per workspace, so cache it.
    const tokens = new Map<string, string>();
    const served = async (workspaceId: string): Promise<AgentRulesResponse> => {
      const token = tokens.get(workspaceId) ?? await boxTokenFor(app, providers, workspaceId);
      tokens.set(workspaceId, token);
      const response = await appRequest(app, "/workspaces/self/agent-rules", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return response.json<AgentRulesResponse>();
    };

    // 1. No rule anywhere: the built-in doc.
    const plain = await create({ defaultMachineTypeId: "small" });
    expect(plain.agentRuleId).toBeNull();
    expect((await served(plain.id)).content).toBe(AGENT_RULES_DOC);

    // The clone source carries the rule a clone inherits.
    const source = await create({ defaultMachineTypeId: "small", agentRuleId: "rule-template" });
    expect(source.agentRuleId).toBe("rule-template");

    // 2. From the clone source: the source's rule.
    const inherited = await create({ cloneFromWorkspaceId: source.id });
    expect(inherited.agentRuleId).toBe("rule-template");
    expect((await served(inherited.id)).content).toBe("# from the template\n");

    // 3. The request beats the clone source.
    const overridden = await create({
      cloneFromWorkspaceId: source.id,
      agentRuleId: "rule-workspace",
    });
    expect(overridden.agentRuleId).toBe("rule-workspace");
    expect((await served(overridden.id)).content).toBe("# from the workspace\n");

    // 4. An explicit null on a cloned create drops back to the built-in.
    const cleared = await create({ cloneFromWorkspaceId: source.id, agentRuleId: null });
    expect(cleared.agentRuleId).toBeNull();
    expect((await served(cleared.id)).content).toBe(AGENT_RULES_DOC);

    // Content-addressed versions still separate the docs.
    const builtInVersion = (await served(plain.id)).version;
    expect((await served(cleared.id)).version).toBe(builtInVersion);
    expect((await served(inherited.id)).version).not.toBe(builtInVersion);
    expect((await served(inherited.id)).version).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("rejects a rule from another org on create and frees references on delete", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const outsider = await userSession("outsider");
    await putRule(app, cookie, "rule-1", { name: "House rules", content: "# house\n" });
    await putRule(app, outsider, "rule-other", { name: "Theirs", content: "# theirs\n" });

    for (const body of [
      { defaultMachineTypeId: "small", agentRuleId: "rule-other" },
      { defaultMachineTypeId: "small", agentRuleId: "missing" },
    ]) {
      expect((await appRequest(app, "/workspaces", {
        ...json(body, "POST"),
        headers: { Cookie: cookie, "Content-Type": "application/json" },
      })).status).toBe(404);
    }
    expect((await appRequest(app, "/workspaces", {
      ...json({ defaultMachineTypeId: "small", agentRuleId: 7 }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);

    const workspaceResponse = await appRequest(app, "/workspaces", {
      ...json({ defaultMachineTypeId: "small", agentRuleId: "rule-1" }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await workspaceResponse.json<{ workspace: WorkspaceView }>()).workspace;
    expect(workspace.agentRuleId).toBe("rule-1");

    // Deleting a referenced rule is allowed; the holders fall back to Default.
    expect((await appRequest(app, "/agent-rules/rule-1", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    expect((await appRequest(app, "/agent-rules/rule-1", {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(404);
    expect((await listRules(app, cookie)).map(({ id }) => id)).toEqual([null]);

    const token = await boxTokenFor(app, providers, workspace.id);
    const served = await appRequest(app, "/workspaces/self/agent-rules", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await served.json<AgentRulesResponse>()).content).toBe(AGENT_RULES_DOC);

    // The workspace that held the rule falls back to the built-in too: the
    // delete nulls every reference rather than refusing.
    const listed = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    expect((await listed.json<{ workspace: WorkspaceView }>()).workspace.agentRuleId).toBeNull();
  });
});
