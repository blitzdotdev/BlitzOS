import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { AgentRuleView, ListAgentRulesResponse } from "./wire.js";

// The single source of truth for these bytes is the box-image skeleton file
// packages/box/rootfs/opt/blitz/skel/agent-rules.md. That file is baked into
// every box and installed to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md at boot
// (blitz-init-state) as the offline fallback. The control-plane Worker cannot
// read files at runtime, so the bytes are mirrored here as a compiled string.
//
// The mirror is pinned byte-for-byte to the .md by
// test/agent-rules-drift.test.ts. Do NOT hand-edit AGENT_RULES_DOC: edit the
// .md (the canonical source) and regenerate this constant. A Worker deploy then
// ships the edited rules to every box that fetches GET
// /workspaces/self/agent-rules, without a new box image.
export const AGENT_RULES_DOC = "# Blitz box — agent rules\n\nThese rules are managed by Blitz. This file is overwritten every time the box\nrestarts, so do not edit it. Put project-specific rules in\n`/workspace/CLAUDE.md` instead — that file is yours and survives restarts.\n\n## Showing a preview to the user\n\nWhen you start a web UI, dev server, or static HTML page for the user, run:\n\n```\nblitz preview open <port>\n```\n\nThis makes the platform **open the preview for the user**. Do it as soon as the\nserver is listening. Never tell a first-time user to go hunt for a preview tab —\nopen it for them.\n\n- `--path <path>` deep-links to a route, e.g. `blitz preview open 3000 --path /dashboard`.\n- `--title <name>` names the preview, e.g. `blitz preview open 5173 --title \"Docs\"`.\n\n### How previews reach the browser\n\n- Listen on a TCP port in the range **1024-65535**. Avoid **7443-7446** and\n  **17445**; the box uses those.\n- Bind to an IPv4 loopback or wildcard address (**`127.0.0.1`** or **`0.0.0.0`**).\n  Do **not** bind IPv6-only (`::1`) — it will not be reached.\n- Within a few seconds the port appears in the workspace preview sidebar. It is\n  served to the browser at `/workspaces/<workspace-id>/webapp/7445/preview/<port>/`.\n- Do **not** try to fetch that URL yourself from inside the box. The browser\n  holds an auth token that the box does not, so the request will fail from here.\n  Just start the server and open the preview.\n\n## Sharing a public link\n\nTo surface a public link you created (for example a `blitz.dev` app you\ndeployed), use:\n\n```\nblitz preview add <url> --title \"<name>\"\nblitz preview list\nblitz preview rm <url>\n```\n\nOnly `https` `*.blitz.dev` links open inline in the preview. Any other link\nopens in a new browser tab.\n\n## Installing packages\n\n- There is no `sudo`. Anything that needs root (including `apt`) will not work.\n- `npm i -g <pkg>` works; global installs go under `/opt/blitz/npm`.\n- `python3` is present, but `pip` is not. Bootstrap pip yourself if you need it\n  (for example with `python3 -m ensurepip` or by fetching `get-pip.py`).\n";

// A stable content hash of AGENT_RULES_DOC. Boxes store it to detect changes.
// Computed deterministically at module load with 64-bit FNV-1a over the UTF-8
// bytes of the doc. It uses no Date.now()/Math.random(), so the version is a
// pure function of the content and stays reproducible across Worker isolates
// and tests.
function contentVersion(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export const AGENT_RULES_VERSION = contentVersion(AGENT_RULES_DOC);

/** The name the picker shows for the doc above. Editing it is copy-on-write:
 * the webApp pre-fills this content and a save creates a real org rule. */
export const BUILT_IN_AGENT_RULE_NAME = "Default (built-in)";

// Matched to MAX_BYTES in packages/box/rootfs/usr/local/bin/blitz-rules: a doc
// the box would refuse to install must never be storable here.
const AGENT_RULE_NAME_MAX = 120;
const AGENT_RULE_CONTENT_MAX_BYTES = 256 * 1024;

export interface AgentRuleRow {
  id: string;
  org_id: string;
  name: string;
  content: string;
  updated_at: number;
}

// The wire shape returned by GET /workspaces/self/agent-rules. This crosses a
// runtime boundary (control-plane producer -> box consumer); the box parser and
// this producer are pinned to the same fixtures under
// packages/schema/fixtures/agent-rules/.
export interface AgentRulesResponse {
  version: string;
  content: string;
}

/** Content-addressed: an org doc gets a version from its own bytes by the same
 * FNV-1a the built-in uses, so the box's change detection needs no change. */
export function agentRulesResponse(content: string = AGENT_RULES_DOC): AgentRulesResponse {
  return { version: contentVersion(content), content };
}

function agentRuleView(row: AgentRuleRow): AgentRuleView {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    updatedAt: row.updated_at,
    builtIn: false,
  };
}

function builtInAgentRuleView(): AgentRuleView {
  return {
    id: null,
    name: BUILT_IN_AGENT_RULE_NAME,
    content: AGENT_RULES_DOC,
    updatedAt: null,
    builtIn: true,
  };
}

/** Resolves an `agentRuleId` a create request carries. Absent and null both
 * mean "no rule of my own"; anything else must name a rule this org owns. */
export async function agentRuleIdForOrg(
  db: Db,
  value: string | null | undefined,
  orgId: string,
): Promise<string | null> {
  if (value === undefined || value === null) return null;
  const rule = await first<{ id: string }>(db, {
    q: "SELECT id FROM agent_rules WHERE id = ?1 AND org_id = ?2 LIMIT 1",
    v: [value, orgId],
  });
  if (rule === null) throw new HttpError(404, "agent rule not found");
  return rule.id;
}

function parsePutAgentRule(value: JsonValue): { name: string; content: string } {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", AGENT_RULE_NAME_MAX).trim();
  if (name === "") throw new HttpError(400, "name is required");
  const content = requiredString(value.content, "content", AGENT_RULE_CONTENT_MAX_BYTES);
  if (content.trim() === "") throw new HttpError(400, "content is required");
  if (new TextEncoder().encode(content).byteLength > AGENT_RULE_CONTENT_MAX_BYTES) {
    throw new HttpError(
      400,
      `content must be at most ${String(AGENT_RULE_CONTENT_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  return { name, content };
}

// Box-authenticated read of the managed agent rules. Boxes call this with their
// access token (see core/credentials/mint.ts and authenticateBox) and write the
// content to the two canonical read paths; on any failure they keep the baked
// fallback. The workspace's own rule wins; a workspace created from a template
// inherits that template's rule at create time (core/workspaces.ts), so a null
// column here means "nobody chose one" and the built-in doc is served.
export function addAgentRulesRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/workspaces/self/agent-rules", async (context) => {
    const runtime = runtimeFactory(context);
    const box = await authenticateBox(context.req.raw, runtime.db);
    if (box === null) throw new HttpError(401, "invalid box access token");
    if (box.workspaceId === null) return context.json(agentRulesResponse());
    const chosen = await first<{ content: string }>(runtime.db, {
      q: `SELECT r.content FROM workspaces w
          JOIN agent_rules r ON r.id = w.agent_rule_id
          WHERE w.id = ?1 LIMIT 1`,
      v: [box.workspaceId],
    });
    return context.json(agentRulesResponse(chosen?.content));
  });
}

/** The org's editable rule library. Any active member may read and write it:
 * rules are shared configuration, like templates, and the create screens are
 * where they are authored. */
export function addAgentRuleLibraryRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  async function orgFor(context: CoreContext): Promise<string> {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    return principal.orgId;
  }

  router.get("/agent-rules", async (context) => {
    const runtime = runtimeFactory(context);
    const orgId = await orgFor(context);
    const stored = await rows<AgentRuleRow>(runtime.db, {
      q: "SELECT * FROM agent_rules WHERE org_id = ?1 ORDER BY name, id",
      v: [orgId],
    });
    return context.json<ListAgentRulesResponse>({
      rules: [builtInAgentRuleView(), ...stored.map(agentRuleView)],
    });
  });

  // Upsert by id, so the webApp mints a UUID for a new rule and reuses this one
  // route to rename or re-edit it. The org is fixed on first write and a second
  // org's PUT to the same id is a 404, not a takeover.
  router.put("/agent-rules/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const orgId = await orgFor(context);
    const id = requiredString(context.req.param("id"), "id", 256);
    const input = parsePutAgentRule(
      await readJson(context.req.raw, AGENT_RULE_CONTENT_MAX_BYTES + 8 * 1024),
    );
    const existing = await first<AgentRuleRow>(runtime.db, {
      q: "SELECT * FROM agent_rules WHERE id = ?1 LIMIT 1",
      v: [id],
    });
    if (existing !== null && existing.org_id !== orgId) {
      throw new HttpError(404, "agent rule not found");
    }
    const twin = await first<{ id: string }>(runtime.db, {
      q: "SELECT id FROM agent_rules WHERE org_id = ?1 AND name = ?2 AND id != ?3 LIMIT 1",
      v: [orgId, input.name, id],
    });
    if (twin !== null) throw new HttpError(409, "an agent rule with that name already exists");
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO agent_rules (id, org_id, name, content, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(id) DO UPDATE SET name = ?3, content = ?4, updated_at = ?5`,
      v: [id, orgId, input.name, input.content, now],
    });
    return context.json(
      { rule: agentRuleView({ id, org_id: orgId, ...input, updated_at: now }) },
      existing === null ? 201 : 200,
    );
  });

  // Deleting a referenced rule is allowed: the templates and workspaces that
  // point at it fall back to the built-in doc. The nulling is done here so the
  // ON DELETE SET NULL semantics hold whether or not D1 enforces the key.
  router.delete("/agent-rules/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const orgId = await orgFor(context);
    const id = requiredString(context.req.param("id"), "id", 256);
    const existing = await first<AgentRuleRow>(runtime.db, {
      q: "SELECT * FROM agent_rules WHERE id = ?1 AND org_id = ?2 LIMIT 1",
      v: [id, orgId],
    });
    if (existing === null) throw new HttpError(404, "agent rule not found");
    await transaction(runtime.db, [
      { q: "UPDATE workspaces SET agent_rule_id = NULL WHERE agent_rule_id = ?1", v: [id] },
      {
        q: "UPDATE workspace_templates SET agent_rule_id = NULL WHERE agent_rule_id = ?1",
        v: [id],
      },
      { q: "DELETE FROM agent_rules WHERE id = ?1", v: [id] },
    ]);
    return context.body(null, 204);
  });
}
