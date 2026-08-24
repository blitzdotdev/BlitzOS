import { describe, expect, it } from "vitest";
import {
  buildBootstrapScript,
  recipeInvocationEnvFile,
  shellQuote,
  type RecipeBootstrap,
} from "../core/bootstrap.js";
import { isRecord, isString, type JsonValue } from "../core/http.js";
import { AGENT_PROVIDERS, RECIPE_HARNESSES } from "../core/wire.js";

/**
 * Cross-runtime conformance for the recipe invocation files
 * (`fixtures/recipe-invocation/`): the control-plane writer must produce
 * exactly the corpus bytes, and the bootstrap must embed exactly those bytes
 * behind `printf '%s' '<quoted>'`. The guest-side readers (the chat sender
 * today, `blitz-term` in Phase 2) revalidate against the same corpus when
 * that image generation lands.
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
  // Only chat carries an agentProvider (it drives BLITZ_AGENT and the
  // sender's permission value); TUI invocations must not name one.
  if (harness === "chat") {
    const agentProvider = AGENT_PROVIDERS.find((candidate) => candidate === value.agentProvider);
    if (agentProvider === undefined) {
      throw new Error(`${name}: a chat invocation.json must name a valid agentProvider`);
    }
    return { harness, agentProvider, prompt: "", ...common };
  }
  if (value.agentProvider !== undefined) {
    throw new Error(`${name}: only chat invocations carry an agentProvider`);
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

  it("embeds the exact fixture bytes, and BLITZ_AGENT only for chat", () => {
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
      // Only chat pins the actor's adapter; a TUI recipe leaves the image
      // default alone so the workspace chat tab keeps it.
      if (bootstrap.harness === "chat") {
        expect(script, name).toContain(`-e BLITZ_AGENT=${shellQuote(bootstrap.agentProvider)} \\`);
      } else {
        expect(script, name).not.toContain("BLITZ_AGENT");
      }
      // The files land before the container starts; the flag rides docker run.
      expect(script.indexOf("/var/lib/blitz/recipe/prompt.txt"), name)
        .toBeLessThan(script.indexOf("docker run --detach"));
    }
  });

  it("emits the prompt sender only for the chat harness", () => {
    for (const { name, bootstrap } of cases) {
      const script = scriptFor(bootstrap);
      const senderPresent = script.includes("<<'RECIPE_SENDER'");
      expect(senderPresent, name).toBe(bootstrap.harness === "chat");
      if (bootstrap.harness !== "chat") continue;
      // Best-effort background delivery, after the health wait, never on the
      // boot's critical path.
      expect(script, name).toContain("nohup docker exec");
      expect(script, name).toContain("node /var/lib/blitz/recipe/sender.cjs");
      expect(script.indexOf("<<'RECIPE_SENDER'"), name)
        .toBeGreaterThan(script.indexOf('[ "$box_healthy" = true ]'));
      expect(script.indexOf("nohup docker exec"), name)
        .toBeLessThan(script.indexOf("read_host_key()"));
      // Model, effort, and the provider's bypass permission are interpolated
      // at render time — the sender reads only prompt.txt from disk.
      expect(script, name).toContain(
        `const MODEL = ${bootstrap.model === undefined ? "null" : JSON.stringify(bootstrap.model)};`,
      );
      expect(script, name).toContain(
        `const EFFORT = ${bootstrap.effort === undefined ? "null" : JSON.stringify(bootstrap.effort)};`,
      );
      expect(script, name).toContain(
        `const PERMISSION = ${JSON.stringify(
          bootstrap.agentProvider === "claude" ? "bypassPermissions" : "never",
        )};`,
      );
      expect(script, name).toContain("prompt.txt");
      // The minimal ACP sequence, one pass, fail-loudly.
      expect(script, name).toContain("'initialize'");
      expect(script, name).toContain("'session/new'");
      expect(script, name).toContain("'session/set_config_option'");
      expect(script, name).toContain("'session/prompt'");
      expect(script, name).toContain("ws://127.0.0.1:7444");
      expect(script, name).toContain("x-blitz-webapp-token");
      // Deleted machinery must stay deleted: no invocation.env re-parse, no
      // permission-prompt auto-allow, no method-not-found responder.
      expect(script, name).not.toContain("parseInvocation");
      expect(script, name).not.toContain("session/request_permission");
      expect(script, name).not.toContain("-32601");
    }
  });

  it("starts the detached remote-control retry loop on every create", () => {
    // No tab attaches to this session: `claude remote-control` exits at once
    // when the box is logged out, so a one-shot session was dead a second
    // after boot. The 15-second retry loop is what notices the member's
    // eventual `/login`. The un-shimmed /opt/blitz/npm/bin/claude path and
    // the env -u flags keep every OAuth credential out of the process
    // (remote-control rejects CLAUDE_CODE_OAUTH_TOKEN), and `|| true` keeps
    // the boot fail-open. The credentials-file guard keeps the logged-out
    // loop from running claude at all: a logged-out run rewrites
    // ~/.claude.json and wiped fresh logins.
    const execLine =
      "docker exec --user 1000:1000 --env HOME=/var/lib/blitz/home --env USER=blitz blitz-box tmux -u new-session -d -s blitz-rc -c /workspace -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 'while :; do [ -s /var/lib/blitz/home/.claude/.credentials.json ] || { sleep 15; continue; }; env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY /opt/blitz/npm/bin/claude remote-control >>/var/lib/blitz/remote-control.log 2>&1; sleep 15; done' || true\n";
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
      const at = script.indexOf(execLine);
      expect(at, name).toBeGreaterThan(-1);
      expect(script.indexOf(execLine, at + 1), name).toBe(-1);
      // After the box is healthy (and after the chat sender when one is
      // emitted), before the phone-home host-key read.
      expect(at, name).toBeGreaterThan(script.indexOf('[ "$box_healthy" = true ]'));
      expect(at, name).toBeLessThan(script.indexOf("read_host_key()"));
      const sender = script.indexOf("<<'RECIPE_SENDER'");
      if (sender !== -1) expect(at, name).toBeGreaterThan(sender);
      // The webApp no longer opens a default terminal tab for it.
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
    expect(script).not.toContain("RECIPE_SENDER");
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
