import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  UPLOAD_MANIFEST,
  WORKER_SOURCE,
  importSpecifiers,
  isRelative,
  redactSecrets,
} from "../scripts/build-blitzdev.mjs";
import { managedUploadSet } from "./managed-upload-set.js";

// Vendor-only: this suite pins the worker source emitted for the blitz.dev
// managed platform, which forks do not use. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

const expected = [
  "teenybase.ts",
  "worker.ts",
  "core/index.ts",
  "core/app.ts",
  "core/runtime.ts",
  "core/db.ts",
  "core/blobs.ts",
  "core/wire.ts",
  "core/agent-rules.ts",
  "core/bootstrap.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/environment.ts",
  "core/connections/types.ts",
  "core/connections/root-crypto.ts",
  "core/connections/manifest.ts",
  "core/connections/leases.ts",
  "core/connections/catalog/types.ts",
  "core/connections/catalog/surfaces.ts",
  "core/connections/catalog/github.ts",
  "core/connections/catalog/google-workspace.ts",
  "core/connections/catalog/linear.ts",
  "core/connections/catalog/discord.ts",
  "core/connections/catalog/youtrack.ts",
  "core/connections/catalog/generic.ts",
  "core/connections/catalog/index.ts",
  "core/connections/user-grants.ts",
  "core/connections/minters/static.ts",
  "core/connections/minters/app-jwt/github-app.ts",
  "core/connections/minters/oauth.ts",
  "core/connections/minters/grant.ts",
  "core/connections/registry.ts",
  "core/connections/requests.ts",
  "core/connections/health.ts",
  "core/connections/canary.ts",
  "core/connections/connect.ts",
  "core/connections/mint.ts",
  "core/connections/proxy.ts",
  "core/http.ts",
  "core/files/access.ts",
  "core/files/attachments.ts",
  "core/files/dav.ts",
  "core/files/folders.ts",
  "core/files/keys.ts",
  "core/files/objects.ts",
  "core/files/readiness.ts",
  "core/files/routes.ts",
  "core/files/schedule.ts",
  "core/files/sync.ts",
  "core/files/usage-push.ts",
  "core/identity/google.ts",
  "core/identity/grants.ts",
  "core/identity/invites.ts",
  "core/identity/members.ts",
  "core/identity/orgs.ts",
  "core/identity/routes.ts",
  "core/janitors.ts",
  "core/oauth-state.ts",
  "core/oauth.ts",
  "core/principals.ts",
  "core/recipes.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/signup-config.js",
  "core/types.ts",
  "core/volumes.ts",
  "core/preview.ts",
  "core/webapp-state.ts",
  "core/webapp-surface.ts",
  "core/webapp-tickets.ts",
  "core/workspace-access.ts",
  "core/workspace-names.ts",
  "core/workspace-records.ts",
  "core/workspace-templates.ts",
  "core/workspace-tunnels.ts",
  "core/workspaces.ts",
  "core/compute/registry.ts",
  "core/compute/types.ts",
  "core/compute/hetzner.ts",
  "core/compute/json-fetch.ts",
  "core/compute/microvm-hosts.js",
  "core/compute/microvm-config.ts",
  "core/compute/microvm-agent.ts",
  "core/compute/microvm-host-registry.ts",
  "core/compute/microvm.ts",
  "core/compute/aws.ts",
  "core/compute/aws-sigv4.ts",
  "core/compute/aws-xml.ts",
  "core/compute/cloudflare-tunnels.ts",
  "core/agent-rules-doc.ts",
] as const;

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed emitter [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("emits the exact deterministic manifest within platform limits", () => {
    const first = managedUploadSet();
    const second = managedUploadSet();
    expect(UPLOAD_MANIFEST).toEqual(expected);
    expect(first.files.map((file) => file.path)).toEqual(expected);
    expect(first).toEqual(second);
    expect(first.files).toHaveLength(91);
    expect(first.files.every((file) => file.bytes <= 1024 * 1024)).toBe(true);
  });

  it("allows no unmanaged import in the upload set", () => {
    const uploadSet = managedUploadSet();
    for (const file of uploadSet.files) {
      const imports = importSpecifiers(file.source);
      if (file.path.startsWith("core/")) {
        expect(imports.every(({ specifier }) => specifier.startsWith("./") || specifier.startsWith("../")), file.path).toBe(true);
      }
    }
    expect(importSpecifiers(WORKER_SOURCE).map(({ specifier }) => specifier)).toEqual([
      "teenybase",
      "virtual:teenybase",
      "./core/index",
    ]);
  });

  // Ask 7, emitter half. The platform Loader does not resolve an explicit
  // `./x.js` onto the `x.ts` it was uploaded: it externalizes the import,
  // still reports bundle.ok, and the deployed Worker throws on every route
  // (run-2 report, B3 — reproduced there in two files). Repo sources stay
  // NodeNext-correct; only the uploaded copies are normalized.
  it("uploads no .js-suffixed relative specifier", () => {
    const uploadSet = managedUploadSet();
    const suffixed = uploadSet.files.flatMap((file) =>
      importSpecifiers(file.source)
        .filter(({ specifier }) => isRelative(specifier) && /\.(?:js|mjs|cjs)$/u.test(specifier))
        .map(({ specifier }) => `${file.path}: ${specifier}`));

    expect(suffixed).toEqual([]);
  });

  // The repo source imports the box-image rules skeleton as a Text module.
  // The managed contract has no text-import mechanism, so the emitter inlines
  // the bytes and repoints the importer at the generated module.
  it("inlines the agent-rules markdown the managed platform cannot import", () => {
    const uploadSet = managedUploadSet();
    const doc = uploadSet.files.find((file) => file.path === "core/agent-rules-doc.ts");
    const importer = uploadSet.files.find((file) => file.path === "core/agent-rules.ts");

    expect(doc?.source).toContain("# Blitz box");
    expect(importer?.source).toContain('from "./agent-rules-doc"');
    // The prose in that file still discusses the .md; no import may reach it.
    const specifiers = importSpecifiers(importer?.source ?? "").map(({ specifier }) => specifier);
    expect(specifiers.filter((specifier) => specifier.endsWith(".md"))).toEqual([]);
    expect(specifiers).toContain("./agent-rules-doc");
  });

  it("emits an environment-resolved app URL without deployment URLs", () => {
    const uploadSet = managedUploadSet();
    const emitted = uploadSet.files.map((file) => file.source).join("\n");
    const teenybase = uploadSet.files.find((file) => file.path === "teenybase.ts");

    expect(teenybase?.source).toContain('appUrl: "$APP_URL"');
    expect(emitted).not.toMatch(/https:\/\/[^\s"']*workers\.dev/iu);
    expect(emitted).not.toContain("blitz-core-probe-caae.app.blitz.dev");
  });

  it("uploads a teenybase config that declares auth:false alongside its own users table", () => {
    const uploadSet = managedUploadSet();
    const teenybase = uploadSet.files.find((file) => file.path === "teenybase.ts");

    expect(teenybase?.source).toContain("const config = {\n  auth: false,\n");
    expect(teenybase?.source).toContain('name: "users"');
  });

  it("wires the managed worker file bucket and scheduled folder sweep", () => {
    expect(WORKER_SOURCE).toContain("fileObjects: env.TEENY_PRIMARY_R2 as R2Bucket");
    expect(WORKER_SOURCE).toContain("async scheduled(");
    expect(WORKER_SOURCE).toContain("await runFileSyncSweep(runtime)");
  });

  // Fake, never a real token: real ones carry a single-underscore `tp_`, which
  // the old `tp__` pattern walked straight past (run-2 report, B9).
  it("redacts agent credentials from diagnostics", () => {
    for (const prefix of ["tp_", "tp__"]) {
      const credential = `${prefix}notarealtoken0000000000`;
      const input = `Authorization: Bearer ${credential} https://blitz.dev/agent/${credential}/agents.md`;
      const output = redactSecrets(input);
      expect(output, prefix).not.toContain(credential);
      expect(output, prefix).toContain("[REDACTED]");
    }
  });
});
