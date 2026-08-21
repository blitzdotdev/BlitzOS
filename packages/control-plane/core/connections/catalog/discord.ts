import type { SkillRenderInput, StaticProviderManifest } from "./types.js";

function skill(input: SkillRenderInput): string {
  const base = input.baseUrlEnv === null ? input.baseUrl : `$${input.baseUrlEnv}`;
  const header = `${input.tokenHeader.name}: ${input.tokenHeader.prefix}$${input.tokenEnv}`;
  return `---
name: ${input.connection}
description: Act as the organization's Discord bot through the REST API and the gateway.
---

# ${input.connection}

This workspace holds the organization's Discord bot token, configured once by
an admin. Everything the agent does renders as the bot in Discord.

## Auth

Send \`${header}\` on every REST call — the prefix is \`Bot\`, not \`Bearer\`.

${input.mode === "proxy"
    ? `\`$${input.tokenEnv}\` is a lease token that only works against \`${base}\`; the control plane swaps in the real bot token on the way out.`
    : `\`$${input.tokenEnv}\` is the bot token itself, so libraries that open the gateway websocket (discord.js, discord.py) work with it directly. Do not echo it, and do not send it anywhere but discord.com.`}

## Canonical calls

\`\`\`sh
# Which bot am I
curl -sS -H '${header}' "${base}/users/@me"

# Guilds the bot is installed in
curl -sS -H '${header}' "${base}/users/@me/guilds"

# Send a message to a channel
curl -sS -X POST -H '${header}' -H 'Content-Type: application/json' \\
  "${base}/channels/{channel.id}/messages" \\
  -d '{"content":"..."}'
\`\`\`

## Reach and limits

- Scopes recorded for this connection: ${input.scopes.length === 0 ? "none — the bot's Discord-side permissions and installed guilds are the boundary" : input.scopes.join(", ")}.
- Receiving events in real time needs the gateway websocket
  (\`wss://gateway.discord.gg\`), which REST alone does not cover.
- Rate limits are per-route buckets; honour \`Retry-After\` on a 429 instead
  of hammering.

## When a call returns 401

The lease expired. Start a new login shell (or run \`blitz-cred sync\`) and
retry once. If it still fails, the admin's bot token was revoked or reset in
the Discord developer portal — say so instead of retrying.
`;
}

/** Admin-configured only: a Discord bot token belongs to the organization's
 * bot application, not to any member, so there is no per-member connect step —
 * `personalToken: null` makes the grants route refuse pastes. The org admin
 * stores the token once:
 *
 *   PUT /connections/discord  kind=static custody=cp root=<bot token>
 *     config.placements = the env surface below
 *
 * Custody is `cp` (inject), not proxy, because bot libraries authenticate the
 * gateway websocket with the raw token; a proxy-custody lease token would
 * break every real-time Discord library while leaving only bare REST. */
export const discordManifest = {
  id: "discord",
  title: "Discord",
  summary: "Send and read messages as your organization's Discord bot.",
  docsUrl: "https://discord.com/developers/docs/reference#authentication",
  custody: "cp",
  // Bot tokens live until an admin resets them in the developer portal.
  rotation: "none",
  // The header quirk this manifest field exists for: bots authenticate with
  // `Bot <token>`, and `Bearer` is rejected.
  tokenHeader: { name: "Authorization", prefix: "Bot " },
  baseUrl: "https://discord.com/api/v10",
  auth: null,
  personalToken: null,
  adminForm: {
    rootLabel: "Bot token",
    rootHelp: "discord.com/developers/applications → your application → Bot → Reset Token. The bot must also be invited to the servers agents should reach.",
    baseUrlLabel: null,
  },
  scopes: [],
  defaultScopes: [],
  surfaces: {
    env: [{ name: "DISCORD_BOT_TOKEN", fill: "token" }],
    skill: { path: ".claude/skills/<provider>/SKILL.md", render: skill },
  },
  probe: {
    request: (input) => ({
      method: "GET",
      url: `${input.baseUrl}/users/@me`,
      headers: [
        { name: input.header.name, value: `${input.header.prefix}${input.token}` },
      ],
      body: null,
    }),
    expect: { status: 200, jsonFields: ["id"] },
  },
  probeFixtures: [
    {
      name: "the bot's own user",
      status: 200,
      response: '{"id":"1029384756000000000","username":"blitz-canary","bot":true}',
      healthy: true,
    },
    {
      name: "reset bot token",
      status: 401,
      response: '{"message":"401: Unauthorized","code":0}',
      healthy: false,
    },
  ],
  fixtures: [],
} satisfies StaticProviderManifest;
