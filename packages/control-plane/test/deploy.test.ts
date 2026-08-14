import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanDist } from "../scripts/clean-dist.mjs";
import {
  deployControlPlane,
  d1DatabasePatch,
  missingSecretsMessage,
  parseD1Binding,
  requiredSecretsForConfig,
} from "../scripts/deploy-helpers.mjs";

describe("control-plane deploy command", () => {
  it("adds MICROVM_HOSTS tokenVar names to required secret metadata without reading values", () => {
    expect(requiredSecretsForConfig({
      vars: {
        MICROVM_HOSTS: JSON.stringify([
          { name: "lab", url: "https://microvm-lab.example", tokenVar: "MICROVM_LAB_TOKEN" },
          { name: "edge", url: "https://microvm-edge.example", tokenVar: "MICROVM_EDGE_TOKEN" },
        ]),
      },
    })).toEqual([
      "HETZNER_API_TOKEN",
      "OPERATOR_API_KEY",
      "CRED_MASTER_KEY",
      "MICROVM_LAB_TOKEN",
      "MICROVM_EDGE_TOKEN",
    ]);
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

  it("creates a missing D1 once, then runs the prompt-free deploy sequence", async () => {
    const calls: Array<{
      tool: string;
      args: string[];
      options: { capture: boolean; env: Record<string, string> };
    }> = [];
    let listCalls = 0;
    let configPatch: unknown;
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
      if (tool === "wrangler" && args[0] === "secret") {
        return {
          stdout: JSON.stringify([
            { name: "HETZNER_API_TOKEN", type: "secret_text" },
            { name: "OPERATOR_API_KEY", type: "secret_text" },
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
      async patchConfig(patch: unknown) {
        configPatch = patch;
      },
    });

    expect(calls.map(({ tool, args }) => [tool, ...args])).toEqual([
      ["wrangler", "whoami", "--json", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "list", "--json", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "create", "blitz-control-plane", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "list", "--json", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "packages/control-plane/wrangler.toml"],
      ["wrangler", "secret", "list", "--format", "json", "--config", "packages/control-plane/wrangler.toml"],
      ["npm", "run", "build", "-w", "@blitzos/ui"],
      ["wrangler", "deploy", "--config", "packages/control-plane/wrangler.toml"],
    ]);
    expect(calls.every(({ options }) => options.env.CI === "1")).toBe(true);
    expect(calls.filter(({ tool, args }) => tool === "wrangler" && args[0] === "d1" && args[1] === "create")).toHaveLength(1);
    expect(configPatch).toMatchObject({
      d1_databases: [
        { database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      ],
    });
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
      }),
    ).rejects.toThrow(missingSecretsMessage(["OPERATOR_API_KEY", "CRED_MASTER_KEY"]));
    expect(calls.some(([tool]) => tool === "npm")).toBe(false);
    expect(calls.some(([tool, command]) => tool === "wrangler" && command === "deploy")).toBe(false);
  });
});
