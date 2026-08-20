import type {
  AgentRuleView,
  ListAgentRulesResponse,
  WorkspaceTemplateView,
  WorkspaceView,
} from "@blitzos/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RULES_DOC,
  BUILT_IN_AGENT_RULE_NAME,
  type AgentRulesResponse,
} from "../core/agent-rules.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
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

/** Boots a workspace far enough to hold a box access token, which is the only
 * identity `GET /workspaces/self/agent-rules` accepts. */
async function boxTokenFor(
  app: TestApp,
  providers: FakeProviders,
  workspaceId: string,
): Promise<string> {
  const ready = await appRequest(app, new URL(phoneHomeUrl(providers, workspaceId)).pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAhost" }),
  });
  return (await ready.json<{ access_token: string }>()).access_token;
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
      { name: "ok", content: "x".repeat(256 * 1024 + 1) },
      { name: 7, content: "# x\n" },
      { name: "ok", content: 7 },
    ];
    for (const candidate of invalid) {
      const response = await putRule(app, cookie, "rule-bad", candidate);
      expect(response.status, JSON.stringify(candidate).slice(0, 80)).toBe(400);
    }
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

  it("resolves the workspace rule ahead of the template rule and the built-in", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putRule(app, cookie, "rule-template", {
      name: "Template rules",
      content: "# from the template\n",
    });
    await putRule(app, cookie, "rule-workspace", {
      name: "Workspace rules",
      content: "# from the workspace\n",
    });

    const templateResponse = await appRequest(app, "/workspace-templates", {
      ...json({
        name: "ruled",
        machineTypeId: "small",
        folderIds: [],
        agentRuleId: "rule-template",
      }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(templateResponse.status).toBe(201);
    const template = (await templateResponse.json<{ template: WorkspaceTemplateView }>()).template;
    expect(template.agentRuleId).toBe("rule-template");

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
    const plain = await create({ machineTypeId: "small" });
    expect(plain.agentRuleId).toBeNull();
    expect((await served(plain.id)).content).toBe(AGENT_RULES_DOC);

    // 2. From the template: the template's rule.
    const inherited = await create({ templateId: template.id });
    expect(inherited.agentRuleId).toBe("rule-template");
    expect((await served(inherited.id)).content).toBe("# from the template\n");

    // 3. The request beats the template.
    const overridden = await create({
      templateId: template.id,
      agentRuleId: "rule-workspace",
    });
    expect(overridden.agentRuleId).toBe("rule-workspace");
    expect((await served(overridden.id)).content).toBe("# from the workspace\n");

    // 4. An explicit null on a templated create drops back to the built-in.
    const cleared = await create({ templateId: template.id, agentRuleId: null });
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
      { machineTypeId: "small", agentRuleId: "rule-other" },
      { machineTypeId: "small", agentRuleId: "missing" },
    ]) {
      expect((await appRequest(app, "/workspaces", {
        ...json(body, "POST"),
        headers: { Cookie: cookie, "Content-Type": "application/json" },
      })).status).toBe(404);
    }
    expect((await appRequest(app, "/workspace-templates", {
      ...json({
        name: "cross org",
        machineTypeId: "small",
        folderIds: [],
        agentRuleId: "rule-other",
      }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(404);
    expect((await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small", agentRuleId: 7 }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);

    const templateResponse = await appRequest(app, "/workspace-templates", {
      ...json({
        name: "ruled",
        machineTypeId: "small",
        folderIds: [],
        agentRuleId: "rule-1",
      }, "POST"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const template = (await templateResponse.json<{ template: WorkspaceTemplateView }>()).template;
    const workspaceResponse = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small", agentRuleId: "rule-1" }, "POST"),
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

    const templates = await appRequest(app, "/workspace-templates", {
      headers: { Cookie: cookie },
    });
    const listedTemplate = (await templates.json<{ templates: WorkspaceTemplateView[] }>())
      .templates.find(({ id }) => id === template.id);
    expect(listedTemplate?.agentRuleId).toBeNull();
  });
});
