import type { SkillRenderInput, StaticProviderManifest } from "./types.js";

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Call the ${input.connection} API with the credential this workspace holds.
---

# ${input.connection}

A static credential for ${input.connection} is available in this workspace.

## Auth

${input.mode === "proxy"
    ? `Send \`${header}\` to \`${base}\` and the control plane attaches the real credential. The value in \`$${input.tokenEnv}\` is a lease token that works only against that base URL.`
    : `The credential itself is in \`$${input.tokenEnv}\`. \`${header}\` is the shape this connection was configured with; check the vendor's own docs before assuming it is right.`}

## Canonical call

\`\`\`sh
curl -sS -H '${header}' "${base}/"
\`\`\`

## Notes

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none" : input.scopes.join(", ")}.
- This is a generic connection: no provider-specific behavior is promised.
  Read the vendor's own documentation before assuming an endpoint shape.
`;
}

/** The catalog entry that keeps today's custom static connections working:
 * any vendor, any environment name, credential pasted rather than granted.
 * Everything vendor-specific comes from the grant's own overrides. */
export const genericManifest = {
  id: "generic",
  title: "Generic API key",
  summary: "Any vendor with a static key: you name the variable and, for proxy custody, the base URL.",
  docsUrl: "https://github.com/blitzdotdev/blitzos",
  custody: "cp",
  rotation: "none",
  tokenHeader: { name: "Authorization", prefix: "Bearer " },
  baseUrl: "https://example.invalid",
  auth: null,
  personalToken: {
    label: "API key",
    help: "Create the key in the vendor's own console. Nothing about it is verified here beyond being non-empty.",
    header: { name: "Authorization", prefix: "Bearer " },
    // The generic vendor form already collects its base URL through
    // `needsVendorConfig`; this field is for catalog entries with fixed names.
    baseUrlLabel: null,
  },
  // Custom connections carry per-grant vendor config; there is no one form an
  // admin could fill once for every vendor this entry might name.
  adminForm: null,
  scopes: [],
  defaultScopes: [],
  delivery: {
    // Placeholders: a generic grant always supplies its own overrides, and
    // these are what the picker shows before the person types anything.
    env: [
      { name: "SERVICE_API_KEY", fill: "token" },
      { name: "SERVICE_BASE_URL", fill: "proxy-url" },
    ],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
  },
  probe: {
    request: (input) => ({
      method: "GET",
      url: input.baseUrl,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
      ],
      body: null,
    }),
    // A generic vendor promises no response shape, so reachability under the
    // credential is the whole contract.
    expect: { status: 200, jsonFields: [] },
  },
  probeFixtures: [
    { name: "reachable", status: 200, response: "{}", healthy: true },
    { name: "rejected key", status: 401, response: '{"error":"unauthorized"}', healthy: false },
  ],
  fixtures: [],
} satisfies StaticProviderManifest;
