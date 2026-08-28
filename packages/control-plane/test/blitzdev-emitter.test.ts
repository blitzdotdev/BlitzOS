import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  UPLOAD_MANIFEST,
  importSpecifiers,
  isRelative,
  managedApiRouting,
  redactSecrets,
  workerSource,
} from "../scripts/build-blitzdev.mjs";
import { coreSources, managedUploadSet } from "./managed-upload-set.js";

// The emitted entry module. Its routing arrays are derived from the core
// sources it ships (see scripts/lib/worker-first-routes.mjs), so it is built
// from the same sources the upload set uses rather than read as a constant.
const WORKER_SOURCE = workerSource(managedApiRouting(coreSources()));

// Vendor-only: this suite pins the worker source emitted for the blitz.dev
// managed platform, which forks do not use. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

// The self-host worker read as text, never evaluated: it is the parity target
// for the emitted one, and a Worker-pool test has no disk to read it from.
const rawSelfHostWorker = import.meta.glob<string>("../src/worker.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** Top-level keys of a worker's `providersFor` return object, in source order. */
function providerKeys(source: string, label: string): string[] {
  const body = /function providersFor\([^)]*\): CoreRuntime\["providers"\] \{[\s\S]*?\n {2}return \{\n([\s\S]*?)\n {2}\};/u
    .exec(source)?.[1];
  if (body === undefined) throw new Error(`no providersFor return object in ${label}`);
  return body
    .split("\n")
    .map((line) => /^ {4}([A-Za-z_$][\w$]*)\s*[:,]/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

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
  "core/box-config.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/entitlements.ts",
  "core/environment.ts",
  "core/connections/types.ts",
  "core/connections/pull-wire.ts",
  "core/connections/root-crypto.ts",
  "core/connections/manifest.ts",
  "core/connections/leases.ts",
  "core/connections/catalog/types.ts",
  "core/connections/catalog/github.ts",
  "core/connections/catalog/google-workspace.ts",
  "core/connections/catalog/linear.ts",
  "core/connections/catalog/discord.ts",
  "core/connections/catalog/youtrack.ts",
  "core/connections/catalog/index.ts",
  "core/connections/user-grants.ts",
  "core/connections/minters/static.ts",
  "core/connections/minters/oauth.ts",
  "core/connections/minters/grant.ts",
  "core/connections/registry.ts",
  "core/connections/requests.ts",
  "core/connections/health.ts",
  "core/connections/canary.ts",
  "core/connections/connect.ts",
  "core/connections/mint.ts",
  "core/connections/proxy.ts",
  "core/connections/github-repo-check.ts",
  "core/connections/github-repositories.ts",
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
  "core/operator-tokens.ts",
  "core/principals.ts",
  "core/recipes.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/version.ts",
  "core/signup-config.js",
  "core/types.ts",
  "core/volumes.ts",
  "core/preview.ts",
  "core/webapp-state.ts",
  "core/webapp-proxy.ts",
  "core/webapp-surface.ts",
  "core/webapp-tickets.ts",
  "core/template-repos.ts",
  "core/workspace-access.ts",
  "core/workspace-names.ts",
  "core/workspace-records.ts",
  "core/workspace-templates.ts",
  "core/workspace-tunnels.ts",
  "core/workspace-volumes.ts",
  "core/workspaces.ts",
  "core/compute/registry.ts",
  "core/compute/types.ts",
  "core/compute/hetzner-config.ts",
  "core/compute/hetzner.ts",
  "core/compute/json-fetch.ts",
  "core/compute/org-credentials.ts",
  "core/compute/workspace-placement.ts",
  "core/compute/microvm-hosts.js",
  "core/compute/microvm-config.ts",
  "core/compute/microvm-agent.ts",
  "core/compute/microvm-host-registry.ts",
  "core/compute/microvm.ts",
  "core/compute/aws.ts",
  "core/compute/aws-prices.ts",
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
    expect(first.files).toHaveLength(102);
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

  it("reads the cloud workspace credential policy in the managed runtime", () => {
    expect(WORKER_SOURCE).toContain("CLOUD_WORKSPACE_CREDENTIAL_POLICY?: string");
    expect(WORKER_SOURCE).toContain(
      "cloudWorkspaceCredentialPolicyFromEnv(\n    env.CLOUD_WORKSPACE_CREDENTIAL_POLICY",
    );
    expect(WORKER_SOURCE).toContain("workspaceCredentialPolicy,");
    expect(WORKER_SOURCE).not.toContain(
      'cloudWorkspaceCredentialPolicy: "deployment-fallback"',
    );
  });

  // Run-3 report, B2. The emitted worker registered only vmRegistry, volume
  // and microvm, so `/workspaces/:id/webapp/:port` could answer nothing but
  // 503 and the browser terminal was unreachable on Target B. Hetzner has no
  // proxyWebApp of its own, so tunnels are the only path.
  it("registers workspace tunnels and webApp auth from the documented env names", () => {
    expect(WORKER_SOURCE).toContain("workspaceTunnels: workspaceTunnelsFromEnv(env)");
    expect(WORKER_SOURCE).toContain("webAppAuth: workspaceWebAppAuthFromEnv(env)");
    // One documented set for both targets: these are the names self-host reads
    // (core/workspace-tunnels.ts, core/webapp-tickets.ts), so an operator sets
    // the same five whether the deployment is Target A or Target B.
    for (const binding of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_ZONE_ID",
      "WORKSPACE_TUNNEL_ZONE",
      "CLOUDFLARE_API_TOKEN",
      "WEBAPP_TOKEN_SECRET",
    ]) {
      expect(WORKER_SOURCE, binding).toContain(`  ${binding}?: string;`);
    }
  });

  // Unconfigured must be loud. Without this the operator sees a bare 503 in a
  // browser and nothing anywhere naming the variables that would fix it.
  it("names the missing variables once per isolate when tunnels are unconfigured", () => {
    expect(WORKER_SOURCE).toContain("warnOnceIfWorkspaceTunnelsUnconfigured(runtime)");
    expect(WORKER_SOURCE).toContain('"workspace_tunnels_unconfigured"');
    expect(WORKER_SOURCE).toContain("set WORKSPACE_TUNNEL_ZONE, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID vars");
    expect(WORKER_SOURCE).toContain("CLOUDFLARE_API_TOKEN, WEBAPP_TOKEN_SECRET secrets");
  });

  // The gate that keeps B2 from coming back under another name: Target B must
  // populate every CoreRuntime["providers"] field Target A populates. A new
  // provider wired into self-host alone now fails the build, instead of
  // surfacing months later as a 503 in someone's browser.
  it("populates every provider the self-host runtime populates", () => {
    const selfHostSource = rawSelfHostWorker["../src/worker.ts"];
    expect(selfHostSource, "self-host worker source").toBeTypeOf("string");
    const selfHost = providerKeys(selfHostSource ?? "", "src/worker.ts");
    const managed = providerKeys(WORKER_SOURCE, "WORKER_SOURCE");

    // Guards the regex itself: a silent no-match would make the gate vacuous.
    expect(selfHost).toContain("vmRegistry");
    expect(selfHost).toContain("workspaceTunnels");
    expect(selfHost).toContain("webAppAuth");
    // Superset, not equality: Target B may add providers Target A has no use
    // for. It may never drop one.
    expect(selfHost.filter((key) => !managed.includes(key))).toEqual([]);
  });

  // Run-4 report, B2. Both targets build on teenyHono, which installs
  // teenybase's error handler, and both then call installControlPlaneRoutes,
  // which installs core/app.ts's. Hono keeps exactly one error handler and the
  // last registration wins, so core/app.ts's is the only error handling either
  // target has — and test/error-envelope.test.ts pins what it does. A worker
  // that registered its own would take a different path from the other one
  // without anything saying so, which is how run 4's opaque 500 hid a 404.
  it("leaves error handling to the one shared handler on both targets", () => {
    const selfHostSource = rawSelfHostWorker["../src/worker.ts"];
    expect(selfHostSource, "self-host worker source").toBeTypeOf("string");
    for (const [label, source] of [
      ["src/worker.ts", selfHostSource ?? ""],
      ["WORKER_SOURCE", WORKER_SOURCE],
    ] as const) {
      expect(source, label).toContain("teenyHono<");
      expect(source, label).toContain("installControlPlaneRoutes(app");
      expect(/\bapp\.onError\(/u.test(source), `${label} registers its own onError`).toBe(false);
      expect(/\bapp\.notFound\(/u.test(source), `${label} registers its own notFound`).toBe(false);
    }
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
