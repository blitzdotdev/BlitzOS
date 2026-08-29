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
  "box-config.ts",
  "box-images.ts",
  "cloud-init.ts",
  "connections/catalog/discord.ts",
  "connections/catalog/github.ts",
  "connections/catalog/google-workspace.ts",
  "connections/catalog/index.ts",
  "connections/catalog/linear.ts",
  "connections/catalog/types.ts",
  "connections/catalog/youtrack.ts",
  "connections/canary.ts",
  "connections/connect.ts",
  "connections/github-repo-check.ts",
  "connections/github-repositories.ts",
  "connections/health.ts",
  "connections/leases.ts",
  "connections/manifest.ts",
  "connections/mint.ts",
  "connections/minters/grant.ts",
  "connections/minters/oauth.ts",
  "connections/minters/static.ts",
  "connections/proxy.ts",
  "connections/pull-routes.ts",
  "connections/pull-wire.ts",
  "connections/registry.ts",
  "connections/requests.ts",
  "connections/root-crypto.ts",
  "connections/types.ts",
  "connections/user-grants.ts",
  "crypto.ts",
  "db.ts",
  "entitlements.ts",
  "environment.ts",
  "files/access.ts",
  "files/attachments.ts",
  "files/dav.ts",
  "files/folders.ts",
  "files/keys.ts",
  "files/objects.ts",
  "files/readiness.ts",
  "files/routes.ts",
  "files/schedule.ts",
  "files/sync.ts",
  "files/usage-push.ts",
  "http.ts",
  "identity/google.ts",
  "identity/invites.ts",
  "identity/members.ts",
  "oauth-state.ts",
  "identity/orgs.ts",
  "identity/routes.ts",
  "index.ts",
  "janitors.ts",
  "machines.ts",
  "oauth.ts",
  "operator-tokens.ts",
  "preview.ts",
  "principals.ts",
  "recipes.ts",
  "compute/aws.ts",
  "compute/aws-prices.ts",
  "compute/aws-sigv4.ts",
  "compute/aws-xml.ts",
  "compute/cloudflare-tunnels.ts",
  "compute/hetzner-config.ts",
  "compute/hetzner.ts",
  "compute/json-fetch.ts",
  "compute/org-credentials.ts",
  "compute/workspace-placement.ts",
  "compute/microvm-agent.ts",
  "compute/microvm-config.ts",
  "compute/microvm-host-registry.ts",
  "compute/microvm-hosts.js",
  "compute/microvm.ts",
  "compute/registry.ts",
  "compute/types.ts",
  "registry.ts",
  "runtime.ts",
  "sessions.ts",
  "version.ts",
  "signup-config.js",
  "template-repos.ts",
  "workspace-names.ts",
  "workspace-access.ts",
  "workspace-credentials.ts",
  "workspace-members.ts",
  "workspace-projection.ts",
  "workspace-records.ts",
  "workspace-settings.ts",
  "workspace-tunnels.ts",
  "workspace-volumes.ts",
  "types.ts",
  "volumes.ts",
  "webapp-state.ts",
  "webapp-proxy.ts",
  "webapp-surface.ts",
  "webapp-tickets.ts",
  "wire-machines.ts",
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
    expect(expected).toHaveLength(104);
  });
});
