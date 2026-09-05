import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { cleanDist } from "../scripts/clean-dist.mjs";
import {
  deployableConfigToml,
  ensureWranglerConfig,
} from "../scripts/ensure-wrangler-config.mjs";
// The committed template, not the gitignored wrangler.toml a local run writes.
import wranglerExample from "../wrangler.toml.example?raw";
import {
  commandFailureMessage,
  configVarProblems,
  configuredAccountId,
  deployControlPlane,
  d1DatabasePatch,
  localSecretValueProblems,
  missingSecretsMessage,
  overrideVarsFromEnvironment,
  parseD1Binding,
  parseR2Binding,
  placeholderVars,
  r2BucketNamesFromList,
  requiredSecretsForConfig,
} from "../scripts/deploy-helpers.mjs";

function commentLines(toml: string): string[] {
  return toml.split("\n").filter((line) => line.trimStart().startsWith("#"));
}

describe("control-plane deploy command", () => {
  // assets.run_worker_first is derived from core/ off disk, and a Worker-pool
  // test has no disk. The derivation itself is gated by
  // test/route-prefixes.test.ts and test/deploy-tooling.test.mjs; what these
  // tests pin is that the deploy writes whatever it derives, in the right
  // order, before the deploy call.
  const DERIVED_ROUTES = ["/", "/version", "/workspaces", "/workspaces/*"];
  const runWorkerFirst = () => DERIVED_ROUTES;
  it("treats OPERATOR_API_KEY as optional legacy, never a required secret", () => {
    expect(requiredSecretsForConfig({ vars: {} }))
      .not.toContain("OPERATOR_API_KEY");
  });

  it("cleans stale package output before rebuilding dist", async () => {
    const packageDirectory = await mkdtemp(path.join(tmpdir(), "blitz-control-plane-build-"));
    const staleFile = path.join(packageDirectory, "dist", "providers", "hetzner.js");
    try {
      await mkdir(path.dirname(staleFile), { recursive: true });
      await writeFile(staleFile, "stale output");

      await cleanDist(packageDirectory);

      await expect(access(path.join(packageDirectory, "dist"))).rejects.toThrow();
    } finally {
      await rm(packageDirectory, { recursive: true, force: true });
    }
  });

  it("updates only the configured D1 binding with the exact database UUID", () => {
    const rawConfig = {
      d1_databases: [
        {
          binding: "AUDIT_DB",
          database_name: "audit",
          database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
        {
          binding: "DB",
          database_name: "blitz-control-plane",
          database_id: "old-id",
          migrations_dir: "migrations",
        },
      ],
    };
    expect(parseD1Binding(rawConfig, "DB")).toEqual({
      binding: "DB",
      databaseName: "blitz-control-plane",
      databaseId: "old-id",
    });

    const patch = d1DatabasePatch(
      rawConfig,
      "DB",
      "blitz-control-plane",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(patch).toEqual({
      d1_databases: [
        rawConfig.d1_databases[0],
        {
          ...rawConfig.d1_databases[1],
          database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
      ],
    });
  });

  it("passes deployment-specific vars through to wrangler, and none when unset", async () => {
    // A setting that differs per deployment and is not secret lives in neither
    // the committed example nor the stored config: the example is one value for
    // everyone, and the stored config is repaired from it on every deploy.
    const calls: { tool: string; args: string[] }[] = [];
    const run = async (tool: string, args: string[]) => {
      calls.push({ tool, args });
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "blitz-control-plane" },
          ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "name:           blitz-box-images" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify(
            ["HETZNER_API_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "WEBAPP_TOKEN_SECRET", "CRED_MASTER_KEY"]
              .map((name) => ({ name, type: "secret_text" })),
          ),
        };
      }
      return { stdout: "" };
    };
    const rawConfig = {
      name: "blitz-control-plane",
      vars: {},
      r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
      d1_databases: [{
        binding: "DB",
        database_name: "blitz-control-plane",
        database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        migrations_dir: "migrations",
      }],
    };

    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig,
      run,
      async patchConfig() {},
      secretValues: {},
      runWorkerFirst: () => DERIVED_ROUTES,
      overrideVars: { CLOUD_WORKSPACE_CREDENTIAL_POLICY: "byok-required" },
    });
    const withVar = calls.find(({ tool, args }) => tool === "wrangler" && args[0] === "deploy");
    expect(withVar?.args).toContain("CLOUD_WORKSPACE_CREDENTIAL_POLICY:byok-required");

    // A self-hoster passes none and keeps the example default.
    calls.length = 0;
    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig,
      run,
      async patchConfig() {},
      secretValues: {},
      runWorkerFirst: () => DERIVED_ROUTES,
    });
    const bare = calls.find(({ tool, args }) => tool === "wrangler" && args[0] === "deploy");
    expect(bare?.args.join(" ")).not.toContain("CLOUD_WORKSPACE_CREDENTIAL_POLICY");
  });

  it("reads override vars from the environment, and treats an unset one as absent", () => {
    // A workflow names a setting with ${{ secrets.NAME }}, which arrives as
    // the empty string until someone sets it. Skipping it is what lets the
    // workflow carry the line before the value exists, so setting it later
    // needs no commit.
    expect(overrideVarsFromEnvironment({
      BLITZ_DEPLOY_VAR_CLOUD_WORKSPACE_CREDENTIAL_POLICY: "byok-required",
      BLITZ_DEPLOY_VAR_PAYMENT_URL: "",
      CLOUDFLARE_API_TOKEN: "not-a-var",
      PAYMENT_URL: "unprefixed, so not a var either",
    })).toEqual({ CLOUD_WORKSPACE_CREDENTIAL_POLICY: "byok-required" });

    expect(overrideVarsFromEnvironment({})).toEqual({});
  });

  it("passes the checked-out commit to the deploy, so GET /version can report it", async () => {
    const calls: { tool: string; args: string[] }[] = [];
    const run = async (tool: string, args: string[]) => {
      calls.push({ tool, args });
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "blitz-control-plane" },
          ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "name:           blitz-box-images" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify(
            [
              "HETZNER_API_TOKEN",
              "GOOGLE_CLIENT_ID",
              "GOOGLE_CLIENT_SECRET",
              "WEBAPP_TOKEN_SECRET",
              "CRED_MASTER_KEY",
            ].map((name) => ({ name, type: "secret_text" })),
          ),
        };
      }
      return { stdout: "" };
    };
    const rawConfig = {
      name: "blitz-control-plane",
      vars: {},
      r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
      d1_databases: [
        {
          binding: "DB",
          database_name: "blitz-control-plane",
          database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          migrations_dir: "migrations",
        },
      ],
    };

    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig,
      run,
      runWorkerFirst,
      async patchConfig() {},
      secretValues: {},
      gitCommitSha: "0bd4a8b1c2d3e4f5",
    });
    const deployCall = calls.find(({ tool, args }) => tool === "wrangler" && args[0] === "deploy");
    expect(deployCall?.args).toContain("--var");
    expect(deployCall?.args).toContain("GIT_COMMIT_SHA:0bd4a8b1c2d3e4f5");

    // A deploy that cannot name its commit must still deploy. An unset var is
    // the honest answer, and GET /version reports "unknown" for it.
    calls.length = 0;
    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig,
      run,
      runWorkerFirst,
      async patchConfig() {},
      secretValues: {},
    });
    const bare = calls.find(({ tool, args }) => tool === "wrangler" && args[0] === "deploy");
    expect(bare?.args).not.toContain("--var");
  });

  it("creates a missing D1 once, then runs the prompt-free deploy sequence", async () => {
    const calls: Array<{
      tool: string;
      args: string[];
      options: { capture: boolean; env: Record<string, string> };
    }> = [];
    let listCalls = 0;
    const patches: unknown[] = [];
    const run = async (
      tool: string,
      args: string[],
      options: { capture: boolean; env: Record<string, string> },
    ) => {
      calls.push({ tool, args, options });
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        listCalls += 1;
        return {
          stdout:
            listCalls === 1
              ? "[]"
              : JSON.stringify([
                  {
                    uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    name: "blitz-control-plane",
                  },
                ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "Listing buckets...\nname:           unrelated-bucket\ncreation_date:  2026-01-01T00:00:00.000Z" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify([
            { name: "HETZNER_API_TOKEN", type: "secret_text" },
            { name: "OPERATOR_API_KEY", type: "secret_text" },
            { name: "GOOGLE_CLIENT_ID", type: "secret_text" },
            { name: "GOOGLE_CLIENT_SECRET", type: "secret_text" },
            { name: "WEBAPP_TOKEN_SECRET", type: "secret_text" },
            { name: "CRED_MASTER_KEY", type: "secret_text" },
          ]),
        };
      }
      return { stdout: "" };
    };

    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig: {
        name: "blitz-control-plane",
        vars: {},
        r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
        d1_databases: [
          {
            binding: "DB",
            database_name: "blitz-control-plane",
            database_id: "old-id",
            migrations_dir: "migrations",
          },
        ],
      },
      repoRoot: "/repo",
      run,
      runWorkerFirst,
      async patchConfig(patch: unknown) {
        patches.push(patch);
      },
      secretValues: {},
    });

    expect(calls.map(({ tool, args }) => [tool, ...args])).toEqual([
      ["wrangler", "whoami", "--json", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "list", "--json", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "create", "blitz-control-plane", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "list", "--json", "--config", "packages/control-plane/wrangler.toml"],
      // The listing runs first so the deploy log names what is about to change.
      ["wrangler", "d1", "migrations", "list", "DB", "--remote", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "r2", "bucket", "list", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "r2", "bucket", "create", "blitz-box-images", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "secret", "list", "--format", "json", "--config", "packages/control-plane/wrangler.toml"],
      ["npm", "run", "build", "-w", "@blitzos/webapp"],
      ["wrangler", "deploy", "--config", "packages/control-plane/wrangler.toml"],
    ]);
    expect(calls.every(({ options }) => options.env.CI === "1")).toBe(true);
    expect(calls.filter(({ tool, args }) => tool === "wrangler" && args[0] === "d1" && args[1] === "create")).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      d1_databases: [
        { database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      ],
    });
    // The derived route list is written last, immediately before the deploy,
    // so a stored deployment config never has to carry it. The key is removed
    // before it is written: wrangler patches an array element by element and
    // would otherwise leave a longer old list's tail behind.
    expect(patches.slice(1)).toEqual([
      { assets: { run_worker_first: DERIVED_ROUTES } },
    ]);
  });

  it("replaces a stale run_worker_first outright instead of writing over its head", async () => {
    // The array in a stored deployment secret is whatever it was when someone
    // last pasted it. wrangler patches an array element by element, so writing
    // a shorter derived list over a longer stale one would leave the stale tail
    // routing requests. The key is deleted first.
    const patches: unknown[] = [];
    const run = async (tool: string, args: string[]) => {
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "blitz-control-plane" },
          ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "name:  blitz-box-images" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify(
            ["HETZNER_API_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "WEBAPP_TOKEN_SECRET", "CRED_MASTER_KEY"]
              .map((name) => ({ name, type: "secret_text" })),
          ),
        };
      }
      return { stdout: "" };
    };

    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig: {
        name: "blitz-control-plane",
        vars: {},
        assets: { run_worker_first: ["/stale-one*", "/stale-two*", "/stale-three*"] },
        r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
        d1_databases: [
          {
            binding: "DB",
            database_name: "blitz-control-plane",
            database_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          },
        ],
      },
      run,
      runWorkerFirst,
      async patchConfig(patch: unknown) {
        patches.push(patch);
      },
      secretValues: {},
    });

    expect(patches).toEqual([
      { assets: { run_worker_first: undefined } },
      { assets: { run_worker_first: DERIVED_ROUTES } },
    ]);
  });

  it("carries captured stderr into the failure a wrangler command reports", () => {
    // A blocker that reads only "failed with exit 1" costs an operator half an
    // hour: wrangler said exactly what was wrong, on stderr, and it was dropped.
    expect(commandFailureMessage(
      "wrangler",
      ["r2", "bucket", "list", "--config", "packages/control-plane/wrangler.toml"],
      "exit 1",
      "✘ [ERROR] More than one account available but unable to select one in non-interactive mode.\n",
    )).toBe(
      "wrangler r2 bucket list --config packages/control-plane/wrangler.toml failed with exit 1\n✘ [ERROR] More than one account available but unable to select one in non-interactive mode.",
    );
    for (const empty of ["", "  \n", undefined]) {
      expect(commandFailureMessage("wrangler", ["deploy"], "signal SIGTERM", empty))
        .toBe("wrangler deploy failed with signal SIGTERM");
    }
  });

  it("scopes every wrangler command to the configured account", async () => {
    // `wrangler r2 bucket list` ignores account_id in the config file, so a
    // multi-account login died there with "More than one account available
    // but unable to select one in non-interactive mode" — after migrations.
    expect(configuredAccountId({ account_id: "53a144fad4e15ca51c32da9b9fe25d4a" }))
      .toBe("53a144fad4e15ca51c32da9b9fe25d4a");
    for (const withoutAccount of [{}, { account_id: "" }, { account_id: "   " }]) {
      expect(configuredAccountId(withoutAccount)).toBeNull();
    }

    const envs: Array<Record<string, string>> = [];
    const rawConfig = {
      name: "blitz-control-plane",
      account_id: "53a144fad4e15ca51c32da9b9fe25d4a",
      vars: {},
      r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
      d1_databases: [
        {
          binding: "DB",
          database_name: "blitz-control-plane",
          database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
      ],
    };
    const run = async (
      tool: string,
      args: string[],
      options: { capture: boolean; env: Record<string, string> },
    ) => {
      envs.push(options.env);
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "blitz-control-plane" },
          ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "name:  blitz-box-images" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify(
            [
              "HETZNER_API_TOKEN",
              "GOOGLE_CLIENT_ID",
              "GOOGLE_CLIENT_SECRET",
              "WEBAPP_TOKEN_SECRET",
              "CRED_MASTER_KEY",
            ].map((name) => ({ name, type: "secret_text" })),
          ),
        };
      }
      return { stdout: "" };
    };

    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig,
      run,
      runWorkerFirst,
      async patchConfig(patch: unknown) {
        if (Object.hasOwn(Object(patch), "d1_databases")) {
          throw new Error("matching D1 config should not be rewritten");
        }
      },
      secretValues: {},
    });
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.every((env) => env.CLOUDFLARE_ACCOUNT_ID === "53a144fad4e15ca51c32da9b9fe25d4a"))
      .toBe(true);

    envs.length = 0;
    await deployControlPlane({
      configPath: "packages/control-plane/wrangler.toml",
      rawConfig: { ...rawConfig, account_id: undefined },
      run,
      runWorkerFirst,
      async patchConfig(patch: unknown) {
        if (Object.hasOwn(Object(patch), "d1_databases")) {
          throw new Error("matching D1 config should not be rewritten");
        }
      },
      secretValues: {},
    });
    expect(envs.every((env) => !("CLOUDFLARE_ACCOUNT_ID" in env))).toBe(true);
  });

  it("fails with exact setup commands when required secret metadata is missing", async () => {
    const calls: Array<[string, ...string[]]> = [];
    const run = async (
      tool: string,
      args: string[],
      _options: { capture: boolean; env: Record<string, string> },
    ) => {
      calls.push([tool, ...args]);
      if (tool === "wrangler" && args[0] === "whoami") return { stdout: "{}" };
      if (tool === "wrangler" && args[0] === "d1" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              name: "blitz-control-plane",
            },
          ]),
        };
      }
      if (tool === "wrangler" && args[0] === "r2" && args[2] === "list") {
        return { stdout: "name:  blitz-box-images" };
      }
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify([
            { name: "HETZNER_API_TOKEN", type: "secret_text" },
          ]),
        };
      }
      return { stdout: "" };
    };

    await expect(
      deployControlPlane({
        configPath: "packages/control-plane/wrangler.toml",
        rawConfig: {
          name: "blitz-control-plane",
          vars: {},
          r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
          d1_databases: [
            {
              binding: "DB",
              database_name: "blitz-control-plane",
              database_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            },
          ],
        },
        repoRoot: "/repo",
        run,
        async patchConfig() {
          throw new Error("matching D1 config should not be rewritten");
        },
        secretValues: {},
      }),
    ).rejects.toThrow(missingSecretsMessage([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "WEBAPP_TOKEN_SECRET",
      "CRED_MASTER_KEY",
    ]));
    expect(calls.some(([tool]) => tool === "npm")).toBe(false);
    expect(calls.some(([tool, command]) => tool === "wrangler" && command === "deploy")).toBe(false);
  });

  it("ships a template a fresh clone can deploy in the documented order", async () => {
    // The deploy is what prints the Worker origin, so APP_URL cannot be known
    // before it; the same is true of the tunnel IDs (step 8) and the box image
    // (step 9). Shipping any of them as a `<...>` placeholder made step 4
    // refuse to run and left the documented order impossible to follow.
    expect(placeholderVars(parseToml(wranglerExample))).toEqual([]);
    for (const deferred of ["APP_URL", "BOX_IMAGE_REF", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"]) {
      expect(wranglerExample, deferred).toContain(`${deferred} = ""`);
    }
  });

  it("generates a comment-free config that carries every key of the example", () => {
    // The deploy writes the new D1 database_id back with wrangler's
    // experimental_patchConfig, which rejects any TOML holding comments
    // ("cannot patch .toml config if comments are present"). The example
    // documents every var inline, so a verbatim copy failed every first
    // deploy — after the D1 already existed. Comments are the only permitted
    // difference between the example and the generated config.
    const generated = deployableConfigToml(wranglerExample);
    expect(commentLines(generated)).toEqual([]);
    expect(commentLines(wranglerExample).length).toBeGreaterThan(0);
    expect(parseToml(generated)).toEqual(parseToml(wranglerExample));
  });

  it("generates the config once and never overwrites a filled-in one", async () => {
    const packageDirectory = await mkdtemp(path.join(tmpdir(), "blitz-control-plane-config-"));
    const configPath = path.join(packageDirectory, "wrangler.toml");
    try {
      await writeFile(path.join(packageDirectory, "wrangler.toml.example"), wranglerExample);

      expect(await ensureWranglerConfig(packageDirectory)).toBe(true);
      const generated = await readFile(configPath, "utf8");
      expect(commentLines(generated)).toEqual([]);
      expect(parseToml(generated)).toEqual(parseToml(wranglerExample));

      await writeFile(configPath, 'name = "operator-edited"\n');
      expect(await ensureWranglerConfig(packageDirectory)).toBe(false);
      expect(await readFile(configPath, "utf8")).toBe('name = "operator-edited"\n');
    } finally {
      await rm(packageDirectory, { recursive: true, force: true });
    }
  });

  it("refuses to deploy vars whose runtime parser would 500 every request", async () => {
    expect(configVarProblems({ vars: { SIGNUP_MODE: "invite-only" } }))
      .toEqual([expect.stringContaining("SIGNUP_MODE must be 'open' or 'invite'")]);
    expect(configVarProblems({ vars: { ALLOWED_EMAIL_DOMAINS: "alice@example.com" } }))
      .toEqual([expect.stringContaining("bare domains")]);
    expect(configVarProblems({ vars: { CLOUD_WORKSPACE_CREDENTIAL_POLICY: "hosted" } }))
      .toEqual([expect.stringContaining("deployment-fallback or byok-required")]);
    expect(configVarProblems({
      vars: {
        SIGNUP_MODE: "invite",
        ALLOWED_EMAIL_DOMAINS: " Example.COM ,corp.test,",
        CLOUD_WORKSPACE_CREDENTIAL_POLICY: "byok-required",
      },
    })).toEqual([]);
    expect(configVarProblems({ vars: {} })).toEqual([]);

    await expect(
      deployControlPlane({
        configPath: "packages/control-plane/wrangler.toml",
        rawConfig: {
          name: "blitz-control-plane",
          vars: { SIGNUP_MODE: "invite-only" },
          r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
          d1_databases: [{ binding: "DB", database_name: "blitz-control-plane" }],
        },
        run: async () => {
          throw new Error("no command should run for an unparseable var");
        },
        async patchConfig() {
          throw new Error("no config patch should run for an unparseable var");
        },
        secretValues: {},
      }),
    ).rejects.toThrow(/SIGNUP_MODE = "invite-only" is invalid/u);
  });

  it("refuses to deploy a config that still holds example placeholder values", async () => {
    await expect(
      deployControlPlane({
        configPath: "packages/control-plane/wrangler.toml",
        rawConfig: {
          name: "blitz-control-plane",
          vars: {
            APP_URL: "<https origin of this worker>",
          },
          r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
          d1_databases: [
            { binding: "DB", database_name: "blitz-control-plane" },
          ],
        },
        run: async () => {
          throw new Error("no command should run for a placeholder config");
        },
        async patchConfig() {
          throw new Error("no config patch should run for a placeholder config");
        },
        secretValues: {},
      }),
    ).rejects.toThrow(/placeholder values for: APP_URL/u);
    expect(placeholderVars({
      vars: { APP_URL: "https://cp.example", WORKSPACE_TUNNEL_ZONE: "" },
    })).toEqual([]);
  });

  it("finds the BOX_IMAGES R2 binding and reads bucket names from wrangler list output", () => {
    expect(parseR2Binding({
      r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "blitz-box-images" }],
    }, "BOX_IMAGES")).toEqual({ binding: "BOX_IMAGES", bucketName: "blitz-box-images" });
    expect(() => parseR2Binding({}, "BOX_IMAGES")).toThrow("must define r2_buckets");
    expect(() => parseR2Binding({ r2_buckets: [] }, "BOX_IMAGES"))
      .toThrow("exactly one BOX_IMAGES R2 binding");
    expect(() => parseR2Binding({
      r2_buckets: [{ binding: "BOX_IMAGES", bucket_name: "Bad Name" }],
    }, "BOX_IMAGES")).toThrow("valid bucket_name");

    const listOutput = [
      "Listing buckets...",
      "name:           blitz-box-images",
      "creation_date:  2026-01-01T00:00:00.000Z",
      "",
      "name:           other-bucket",
      "creation_date:  2026-01-02T00:00:00.000Z",
    ].join("\n");
    expect([...r2BucketNamesFromList(listOutput)]).toEqual([
      "blitz-box-images",
      "other-bucket",
    ]);
  });

  it("validates locally readable secret values and skips unreadable ones silently", () => {
    const rawConfig = { vars: {} };
    expect(localSecretValueProblems(rawConfig, {})).toEqual([]);
    expect(localSecretValueProblems(rawConfig, {
      CRED_MASTER_KEY: "A".repeat(43) + "=",
    })).toEqual([]);
    for (const malformed of ["not base64!!", "AAAA", `${"A".repeat(43)}=A`]) {
      expect(localSecretValueProblems(rawConfig, { CRED_MASTER_KEY: malformed })).toEqual([
        "CRED_MASTER_KEY must be base64 of exactly 32 bytes (generate one with: openssl rand -base64 32)",
      ]);
    }
  });
});
