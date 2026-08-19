import { HttpError } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { CoreRouter, RuntimeFactory } from "./runtime.js";

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

// The wire shape returned by GET /workspaces/self/agent-rules. This crosses a
// runtime boundary (control-plane producer -> box consumer); the box parser and
// this producer are pinned to the same fixtures under
// packages/schema/fixtures/agent-rules/.
export interface AgentRulesResponse {
  version: string;
  content: string;
}

export function agentRulesResponse(): AgentRulesResponse {
  return { version: AGENT_RULES_VERSION, content: AGENT_RULES_DOC };
}

// Box-authenticated read of the managed agent rules. Boxes call this with their
// access token (see core/credentials/mint.ts and authenticateBox) and write the
// content to the two canonical read paths; on any failure they keep the baked
// fallback. It is a pure read: authentication performs the only DB access.
export function addAgentRulesRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/workspaces/self/agent-rules", async (context) => {
    const runtime = runtimeFactory(context);
    const box = await authenticateBox(context.req.raw, runtime.db);
    if (box === null) throw new HttpError(401, "invalid box access token");
    return context.json(agentRulesResponse());
  });
}
