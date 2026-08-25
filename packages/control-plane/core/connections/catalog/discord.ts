import type { StaticProviderManifest } from "./types.js";

/** Admin-configured only: a Discord bot token belongs to the organization's
 * bot application, not to any member, so there is no per-member connect step —
 * `personalToken: null` makes the grants route refuse pastes. The org admin
 * stores the token once:
 *
 *   PUT /connections/discord  kind=static custody=cp root=<bot token>
 *     config.placements = the env delivery below
 *
 * Custody is `cp` (inject), not proxy, because bot libraries authenticate the
 * gateway websocket with the raw token; a proxy-custody lease token would
 * break every real-time Discord library while leaving only bare REST. */
export const discordManifest = {
  id: "discord",
  title: "Discord",
  summary: "Send and read messages as your organization's Discord bot.",
  custody: "cp",
  // The header quirk this manifest field exists for: bots authenticate with
  // `Bot <token>`, and `Bearer` is rejected.
  tokenHeader: { name: "Authorization", prefix: "Bot " },
  baseUrl: "https://discord.com/api/v10",
  auth: null,
  personalToken: null,
  adminForm: {
    rootLabel: "Bot token",
    rootHelp: "discord.com/developers/applications → your application → Bot → Reset Token. The bot must also be invited to the servers agents should reach.",
    app: null,
  },
  scopes: [],
  defaultScopes: [],
  delivery: {
    env: [
      { name: "DISCORD_BOT_TOKEN", fill: "token" },
      // The <PROVIDER>_TOKEN alias. Libraries differ on which name they read.
      { name: "DISCORD_TOKEN", fill: "token" },
    ],
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
} satisfies StaticProviderManifest;
