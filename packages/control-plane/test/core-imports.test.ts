import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../core/**/*.ts", "../core/**/*.js"], {
  eager: true,
  import: "default",
  query: "?raw",
});

const expected = [
  "agent-rules.ts",
  "app.ts",
  "blobs.ts",
  "bootstrap.ts",
  "box-images.ts",
  "cloud-init.ts",
  "credentials/leases.ts",
  "credentials/manifest.ts",
  "credentials/mint.ts",
  "credentials/minters/app-jwt/github-app.ts",
  "credentials/minters/static.ts",
  "credentials/proxy.ts",
  "credentials/registry.ts",
  "credentials/requests.ts",
  "credentials/root-crypto.ts",
  "credentials/types.ts",
  "crypto.ts",
  "db.ts",
  "environment.ts",
  "files/access.ts",
  "files/attachments.ts",
  "files/folders.ts",
  "files/keys.ts",
  "files/objects.ts",
  "files/readiness.ts",
  "files/routes.ts",
  "files/schedule.ts",
  "files/sync.ts",
  "http.ts",
  "identity/google.ts",
  "identity/grants.ts",
  "identity/invites.ts",
  "identity/members.ts",
  "identity/oauth-state.ts",
  "identity/orgs.ts",
  "identity/routes.ts",
  "index.ts",
  "janitors.ts",
  "oauth.ts",
  "preview.ts",
  "principals.ts",
  "providers/cloudflare-tunnels.ts",
  "providers/hetzner.ts",
  "providers/json-fetch.ts",
  "providers/microvm-agent.ts",
  "providers/microvm-config.ts",
  "providers/microvm-host-registry.ts",
  "providers/microvm-hosts.js",
  "providers/microvm.ts",
  "providers/registry.ts",
  "providers/types.ts",
  "registry.ts",
  "runtime.ts",
  "sessions.ts",
  "signup-config.js",
  "workspace-names.ts",
  "workspace-access.ts",
  "workspace-templates.ts",
  "workspace-records.ts",
  "workspace-tunnels.ts",
  "types.ts",
  "volumes.ts",
  "webapp-state.ts",
  "webapp-surface.ts",
  "webapp-tickets.ts",
  "wire.ts",
  "workspaces.ts",
] as const;

describe("portable core imports", () => {
  it("contains exactly the design module set and only relative imports", async () => {
    const actual = Object.keys(sources)
      .map((file) => file.replace("../core/", ""))
      .sort();
    expect(actual).toEqual([...expected].sort());
    for (const relative of expected) {
      const source = sources[`../core/${relative}`];
      if (source === undefined) throw new Error(`missing core source: ${relative}`);
      const specifiers = [...source.matchAll(/\b(?:from|import)\s*(?:\([^)]*\)|["']([^"']+)["'])/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      expect(specifiers, relative).toSatisfy(
        (values: string[]) => values.every((value) => value.startsWith("./") || value.startsWith("../")),
      );
    }
    expect(expected).toHaveLength(67);
  });
});
