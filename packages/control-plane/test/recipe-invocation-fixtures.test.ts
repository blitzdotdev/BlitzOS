import { describe, expect, it } from "vitest";
import {
  buildBootstrapScript,
  recipeInvocationEnvFile,
  shellQuote,
  type RecipeBootstrap,
} from "../core/bootstrap.js";
import { isRecord, isString, type JsonValue } from "../core/http.js";
import { RECIPE_HARNESSES } from "../core/wire.js";

/**
 * Cross-runtime conformance for the recipe invocation files
 * (`fixtures/recipe-invocation/`): the control-plane writer must produce
 * exactly the corpus bytes, and the bootstrap must embed exactly those bytes
 * behind `printf '%s' '<quoted>'`. The guest-side reader `blitz-term`
 * revalidates against the same corpus in
 * `packages/box/guest-tests/test/recipe-invocation-guest.test.ts`.
 */
const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/recipe-invocation/cases/**",
  { eager: true, import: "default", query: "?raw" },
);

interface InvocationCase {
  name: string;
  bootstrap: RecipeBootstrap;
  promptBytes: string;
  envBytes: string;
}

function parseInvocationDescriptor(name: string, source: string): RecipeBootstrap {
  const value: JsonValue = JSON.parse(source);
  if (!isRecord(value)) throw new Error(`${name}: invocation.json must be an object`);
  const harness = RECIPE_HARNESSES.find((candidate) => candidate === value.harness);
  if (harness === undefined) {
    throw new Error(`${name}: invocation.json harness is invalid`);
  }
  const common: { model?: string; effort?: string } = {};
  if (value.model !== undefined) {
    if (!isString(value.model)) throw new Error(`${name}: model must be a string`);
    common.model = value.model;
  }
  if (value.effort !== undefined) {
    if (!isString(value.effort)) throw new Error(`${name}: effort must be a string`);
    common.effort = value.effort;
  }
  // agentProvider belonged to the retired chat harness. No invocation carries
  // one now, so any surviving key is a fixture that was never updated.
  if (value.agentProvider !== undefined) {
    throw new Error(`${name}: agentProvider is retired; no invocation.json may carry one`);
  }
  return { harness, prompt: "", ...common };
}

function loadCases(): InvocationCase[] {
  const byCase = new Map<string, Map<string, string>>();
  for (const [path, source] of Object.entries(fixtureSources)) {
    const match = /\/recipe-invocation\/cases\/([^/]+)\/([^/]+)$/u.exec(path);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const files = byCase.get(match[1]) ?? new Map<string, string>();
    files.set(match[2], source);
    byCase.set(match[1], files);
  }
  return [...byCase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, files]) => {
      const descriptor = files.get("invocation.json");
      const promptBytes = files.get("prompt.txt");
      const envBytes = files.get("invocation.env");
      if (descriptor === undefined || promptBytes === undefined || envBytes === undefined) {
        throw new Error(`fixture case ${name} is missing a file`);
      }
      const bootstrap = parseInvocationDescriptor(name, descriptor);
      bootstrap.prompt = promptBytes;
      return { name, bootstrap, promptBytes, envBytes };
    });
}

/** Reverses shellQuote's single-quote convention the way a POSIX shell reads
 * it, so the test proves `printf '%s' <quoted>` reproduces the corpus bytes.
 * Exact for any value that does not itself contain the escape token. */
function unquoteShell(token: string): string {
  expect(token.startsWith("'")).toBe(true);
  expect(token.endsWith("'")).toBe(true);
  return token.slice(1, -1).replaceAll(`'"'"'`, "'");
}

function scriptFor(recipe: RecipeBootstrap): string {
  return buildBootstrapScript({
    boxImageSha256: "",
    boxImageRef: "ghcr.io/blitzdotdev/blitz-box@sha256:" + "a".repeat(64),
    boxImageTag: "",
    phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
    sshPublicKey: "ssh-ed25519 AAAAcaller",
    recipe,
  });
}

describe("recipe invocation fixture conformance", () => {
  const cases = loadCases();

  it("covers the corpus", () => {
    expect(cases.map(({ name }) => name)).toEqual([
      "full",
      "minimal",
      "newlines",
      "quoted-env-value",
      "quoting",
    ]);
  });

  it("writes exactly the fixture invocation.env bytes", () => {
    for (const { name, bootstrap, envBytes } of cases) {
      expect(recipeInvocationEnvFile(bootstrap), name).toBe(envBytes);
    }
  });

  it("round-trips every fixture through the shell quoting", () => {
    for (const { name, promptBytes, envBytes } of cases) {
      expect(unquoteShell(shellQuote(promptBytes)), name).toBe(promptBytes);
      expect(unquoteShell(shellQuote(envBytes)), name).toBe(envBytes);
    }
  });

  it("embeds the exact fixture bytes and never names an agent backend", () => {
    for (const { name, bootstrap, promptBytes, envBytes } of cases) {
      const script = scriptFor(bootstrap);
      expect(script, name).toContain(
        `printf '%s' ${shellQuote(promptBytes)} >/var/lib/blitz/recipe/prompt.txt`,
      );
      expect(script, name).toContain(
        `printf '%s' ${shellQuote(envBytes)} >/var/lib/blitz/recipe/invocation.env`,
      );
      expect(script, name).toContain("install -d -o 1000 -g 1000 -m 0700 /var/lib/blitz/recipe");
      expect(script, name).toContain(
        "chmod 0600 /var/lib/blitz/recipe/prompt.txt /var/lib/blitz/recipe/invocation.env",
      );
      // BLITZ_AGENT chose the retired actor's adapter. Nothing reads it, so a
      // recipe launch must never set it again.
      expect(script, name).not.toContain("BLITZ_AGENT");
      // The files land before the container starts; the flag rides docker run.
      expect(script.indexOf("/var/lib/blitz/recipe/prompt.txt"), name)
        .toBeLessThan(script.indexOf("docker run --detach"));
    }
  });

  it("starts no remote-control session on any create, recipe or not", () => {
    // Parked 2026-08-24. Bootstrap used to emit a detached `blitz-rc` tmux
    // session for `claude remote-control` on every create. That session made
    // the box's tmux server from a bare `docker exec` environment, and every
    // later tab inherited it, so fresh-workspace logins broke. No create
    // shape may start a tmux server again.
    const plain = buildBootstrapScript({
      boxImageSha256: "",
      boxImageRef: "ghcr.io/blitzdotdev/blitz-box@sha256:" + "a".repeat(64),
      boxImageTag: "",
      phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
      sshPublicKey: "ssh-ed25519 AAAAcaller",
    });
    const scripts: Array<[string, string]> = [
      ["non-recipe", plain],
      ...cases.map(({ name, bootstrap }): [string, string] => [name, scriptFor(bootstrap)]),
    ];
    for (const [name, script] of scripts) {
      expect(script, name).not.toContain("blitz-rc");
      expect(script, name).not.toContain("remote-control");
      expect(script, name).not.toContain("tmux");
      expect(script, name).not.toContain("term-3");
    }
  });

  it("keeps the non-recipe bootstrap free of every recipe segment", () => {
    const script = buildBootstrapScript({
      boxImageSha256: "",
      boxImageRef: "ghcr.io/blitzdotdev/blitz-box@sha256:" + "a".repeat(64),
      boxImageTag: "",
      phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
      sshPublicKey: "ssh-ed25519 AAAAcaller",
    });
    expect(script).not.toContain("/var/lib/blitz/recipe");
    expect(script).not.toContain("BLITZ_AGENT");
    expect(script).not.toContain("agent-usage");
  });

  it("adds the usage-capture directories and read-only mounts only when asked", () => {
    const base = {
      boxImageSha256: "",
      boxImageRef: "ghcr.io/blitzdotdev/blitz-box@sha256:" + "a".repeat(64),
      boxImageTag: "",
      phoneHomeUrl: "https://cp.example/workspaces/workspace/phone-home/token",
      sshPublicKey: "ssh-ed25519 AAAAcaller",
    };
    const captured = buildBootstrapScript({ ...base, usageCapture: true });
    expect(captured).toContain("install -d -o 1000 -g 1000 /var/lib/blitz/home/.claude/projects");
    expect(captured).toContain("install -d -o 1000 -g 1000 /var/lib/blitz/home/.codex/sessions");
    expect(captured).toContain("install -d -o 1000 -g 1000 /var/lib/blitz/workspace/shared/agent-usage");
    expect(captured).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.claude/projects,dst=/workspace/shared/agent-usage/claude,readonly \\",
    );
    expect(captured).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.codex/sessions,dst=/workspace/shared/agent-usage/codex,readonly \\",
    );
    expect(captured.indexOf("/var/lib/blitz/home/.claude/projects"))
      .toBeLessThan(captured.indexOf("docker run --detach"));
    const plain = buildBootstrapScript({ ...base, usageCapture: false });
    expect(plain).not.toContain("agent-usage");
    expect(plain).toBe(buildBootstrapScript(base));
  });
});
