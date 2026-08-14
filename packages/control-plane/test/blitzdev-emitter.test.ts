import { describe, expect, it } from "vitest";
import {
  CORE_MANIFEST,
  UPLOAD_MANIFEST,
  WORKER_SOURCE,
  createUploadSet,
  importSpecifiers,
  redactSecrets,
} from "../scripts/build-blitzdev.mjs";

const rawCore = import.meta.glob<string>("../core/**/*.ts", {
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
  "core/credentials/types.ts",
  "core/credentials/root-crypto.ts",
  "core/credentials/manifest.ts",
  "core/credentials/leases.ts",
  "core/credentials/minters/static.ts",
  "core/credentials/minters/app-jwt/github-app.ts",
  "core/credentials/registry.ts",
  "core/credentials/requests.ts",
  "core/credentials/mint.ts",
  "core/credentials/proxy.ts",
  "core/http.ts",
  "core/janitors.ts",
  "core/oauth.ts",
  "core/principals.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/types.ts",
  "core/volumes.ts",
  "core/workspaces.ts",
  "core/providers/composite.ts",
  "core/providers/types.ts",
  "core/providers/hetzner.ts",
  "core/providers/microvm.ts",
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
    expect(first.files).toHaveLength(35);
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

  it("redacts agent credentials from diagnostics", () => {
    const credential = ["tp", "private-agent-token"].join("__");
    const input = `Authorization: Bearer ${credential} https://blitz.dev/agent/${credential}/agents.md`;
    const output = redactSecrets(input);
    expect(output).not.toContain(credential);
    expect(output).toContain("[REDACTED]");
  });
});
