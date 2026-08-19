import { describe, expect, it } from "vitest";
import { AGENT_RULES_DOC, AGENT_RULES_VERSION } from "../core/agent-rules.js";

// The box-image skeleton .md is the single source of truth for the rule bytes.
// Vite inlines it at build time (?raw): the Workers test pool has no runtime
// filesystem, so this is how the canonical bytes reach the assertion. If the
// compiled mirror in core/agent-rules.ts drifts from the .md, this fails.
const canonicalSources = import.meta.glob<string>(
  "../../box/rootfs/opt/blitz/skel/agent-rules.md",
  { eager: true, import: "default", query: "?raw" },
);

function canonicalDoc(): string {
  const entries = Object.values(canonicalSources);
  if (entries.length !== 1) {
    throw new Error(`expected one canonical agent-rules.md, found ${entries.length}`);
  }
  const [doc] = entries;
  if (doc === undefined) throw new Error("canonical agent-rules.md was not inlined");
  return doc;
}

function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("agent-rules control-plane mirror", () => {
  it("keeps AGENT_RULES_DOC byte-identical to the box-image skeleton .md", () => {
    // A single character of drift (including a trailing-newline change) fails
    // here, which is the whole point: the .md is canonical, the string mirrors.
    expect(AGENT_RULES_DOC).toBe(canonicalDoc());
  });

  it("derives AGENT_RULES_VERSION deterministically from the doc content", () => {
    expect(AGENT_RULES_VERSION).toMatch(/^[0-9a-f]{16}$/u);
    // The version is a pure content hash: recomputing over the same bytes must
    // reproduce it exactly, with no Date.now()/Math.random() in the module.
    expect(AGENT_RULES_VERSION).toBe(fnv1a64Hex(AGENT_RULES_DOC));
    expect(AGENT_RULES_VERSION).toBe(fnv1a64Hex(canonicalDoc()));
  });
});
