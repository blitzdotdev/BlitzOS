import { describe, expect, it } from "vitest";
import {
  CORE_MANIFEST,
  UPLOAD_MANIFEST,
  WORKER_SOURCE,
  createUploadSet,
  importSpecifiers,
  redactSecrets,
} from "../scripts/build-blitzdev.mjs";

const rawCore = import.meta.glob<string>(["../core/**/*.ts", "../core/**/*.js"], {
  eager: true,
  import: "default",
  query: "?raw",
});

const expected = [
  "teenybase.ts",
  "worker.ts",
  "core/index.ts",
  "core/app.ts",
  "core/runtime.ts",
  "core/db.ts",
  "core/blobs.ts",
  "core/wire.ts",
  "core/bootstrap.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/connections/types.ts",
  "core/connections/root-crypto.ts",
  "core/connections/manifest.ts",
  "core/connections/leases.ts",
  "core/connections/catalog/types.ts",
  "core/connections/catalog/surfaces.ts",
  "core/connections/catalog/github.ts",
  "core/connections/catalog/google-workspace.ts",
  "core/connections/catalog/linear.ts",
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
  "core/files/folders.ts",
  "core/files/keys.ts",
  "core/files/objects.ts",
  "core/files/routes.ts",
  "core/files/sync.ts",
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
  "core/registry.ts",
  "core/sessions.ts",
  "core/types.ts",
  "core/volumes.ts",
  "core/webapp-state.ts",
  "core/workspace-access.ts",
  "core/workspace-records.ts",
  "core/workspace-templates.ts",
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
] as const;

function coreSources(): Map<string, string> {
  return new Map(CORE_MANIFEST.map((uploadPath) => {
    const source = rawCore[`../${uploadPath}`];
    if (source === undefined) throw new Error(`missing test source ${uploadPath}`);
    return [uploadPath, source];
  }));
}

describe("blitz.dev managed emitter", () => {
  it("emits the exact deterministic manifest within platform limits", () => {
    const first = createUploadSet(coreSources());
    const second = createUploadSet(coreSources());
    expect(UPLOAD_MANIFEST).toEqual(expected);
    expect(first.files.map((file) => file.path)).toEqual(expected);
    expect(first).toEqual(second);
    expect(first.files).toHaveLength(71);
    expect(first.files.every((file) => file.bytes <= 1024 * 1024)).toBe(true);
  });

  it("allows no unmanaged import in the upload set", () => {
    const uploadSet = createUploadSet(coreSources());
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

  it("emits an environment-resolved app URL without deployment URLs", () => {
    const uploadSet = createUploadSet(coreSources());
    const emitted = uploadSet.files.map((file) => file.source).join("\n");
    const teenybase = uploadSet.files.find((file) => file.path === "teenybase.ts");

    expect(teenybase?.source).toContain('appUrl: "$APP_URL"');
    expect(emitted).not.toMatch(/https:\/\/[^\s"']*workers\.dev/iu);
    expect(emitted).not.toContain("blitz-core-probe-caae.app.blitz.dev");
  });

  it("wires the managed worker file bucket and scheduled folder sweep", () => {
    expect(WORKER_SOURCE).toContain("fileObjects: env.TEENY_PRIMARY_R2 as R2Bucket");
    expect(WORKER_SOURCE).toContain("async scheduled(");
    expect(WORKER_SOURCE).toContain("await runFileSyncSweep(runtime)");
  });

  it("redacts agent credentials from diagnostics", () => {
    const credential = ["tp", "private-agent-token"].join("__");
    const input = `Authorization: Bearer ${credential} https://blitz.dev/agent/${credential}/agents.md`;
    const output = redactSecrets(input);
    expect(output).not.toContain(credential);
    expect(output).toContain("[REDACTED]");
  });
});
