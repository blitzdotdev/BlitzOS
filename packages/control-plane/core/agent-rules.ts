import agentRulesMarkdown from "../../box/rootfs/opt/blitz/skel/agent-rules.md";
import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type {
  AgentRulesResponse,
  AgentRuleView,
  ListAgentRulesResponse,
  PutAgentRuleRequest,
} from "./wire.js";

// The box-image skeleton file packages/box/rootfs/opt/blitz/skel/agent-rules.md
// is the single source of truth for these bytes, at build time and at runtime.
// That file is baked into every box and installed to ~/.claude/CLAUDE.md and
// ~/.codex/AGENTS.md at boot (blitz-init-state) as the offline fallback; the
// import above carries the same bytes into the Worker bundle as a Text module
// (see the `[[rules]]` block in wrangler.toml), because a Worker has no
// filesystem to read them from.
//
// Editing the .md is therefore the whole change: a Worker deploy ships the
// edited rules to every box that fetches GET /workspaces/self/agent-rules,
// without a new box image and without a second copy to keep in step.
//
// Caveat for the `tsc` build: dist/ emits the import specifier unchanged, and
// the .md sits outside the package, so `dist/src/index.js` cannot be loaded by
// plain Node. Nothing imports it — the Worker is bundled from src/worker.ts and
// the only dist consumer is dist/core/bootstrap.js — but do not add one without
// staging the .md alongside the build.
export const AGENT_RULES_DOC: string = agentRulesMarkdown;

/** A stable content hash: 64-bit FNV-1a over the UTF-8 bytes of a doc. It uses
 * no Date.now()/Math.random(), so a version is a pure function of the content
 * and stays reproducible across Worker isolates and tests. The box logs the
 * version it installed; it never persists one, so the hash exists to make a
 * redelivery distinguishable from an edit in the logs and in the fixtures. */
export function contentVersion(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The name the picker shows for the doc above. Editing it is copy-on-write:
 * the webApp pre-fills this content and a save creates a real org rule. */
export const BUILT_IN_AGENT_RULE_NAME = "Default (built-in)";

const AGENT_RULE_NAME_MAX = 120;

/** The one cap on the one quantity both runtimes measure: the UTF-8 byte
 * length of `content`. `MAX_CONTENT_BYTES` in
 * packages/box/rootfs/usr/local/bin/blitz-rules is the same number applied to
 * the same string after parsing, so a doc this route stores is always a doc the
 * box will install. Comparing envelope bytes instead would break that: JSON
 * escaping can expand a legal doc several times over. */
export const AGENT_RULE_CONTENT_MAX_BYTES = 256 * 1024;

/** Request-body headroom for the JSON envelope around `content`. JSON escaping
 * costs at most six bytes per content byte (a C0 control character becomes
 * `\u00XX`), so this is the smallest bound that can never reject a body whose
 * content is within the cap above. The box uses the same multiple. */
const AGENT_RULE_ENVELOPE_MAX_BYTES = 6 * AGENT_RULE_CONTENT_MAX_BYTES + 8 * 1024;

export interface AgentRuleRow {
  id: string;
  org_id: string;
  name: string;
  content: string;
  updated_at: number;
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

function parsePutAgentRule(value: JsonValue): PutAgentRuleRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", AGENT_RULE_NAME_MAX).trim();
  if (name === "") throw new HttpError(400, "name is required");
  // The built-in doc is a synthetic row the list endpoint prepends; it has no
  // id, so UNIQUE(org_id, name) cannot stop a stored rule from claiming its
  // label. Two identically-named options in the picker name different docs.
  if (name === BUILT_IN_AGENT_RULE_NAME) {
    throw new HttpError(400, "name is reserved for the built-in document");
  }
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
// fallback. The workspace's own rule wins; a workspace created from another
// workspace inherits that source's rule at create time, so a null
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
      await readJson(context.req.raw, AGENT_RULE_ENVELOPE_MAX_BYTES),
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
        q: "UPDATE workspaces SET agent_rule_id = NULL WHERE agent_rule_id = ?1",
        v: [id],
      },
      { q: "DELETE FROM agent_rules WHERE id = ?1", v: [id] },
    ]);
    return context.body(null, 204);
  });
}
