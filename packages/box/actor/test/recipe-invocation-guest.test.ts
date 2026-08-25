import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Guest side of the `recipe invocation files` cross-runtime contract. The
 * control-plane writer is pinned against the same corpus in
 * packages/control-plane/test/recipe-invocation-fixtures.test.ts; here the
 * shared parser that blitz-term sources (rootfs/usr/local/libexec/
 * blitz-recipe-invocation — one implementation, never duplicated) is driven
 * against every fixture case, and blitz-term itself runs with a stub tmux to
 * pin the delivery semantics: create-only, once-only, `ro` never consumes,
 * HARNESS=chat never consumed by blitz-term. */

const helperPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-recipe-invocation", import.meta.url),
);
const blitzTermPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-term", import.meta.url),
);
/** blitz-term resolves its codex launcher as a sibling of itself, the same way
 * it sources blitz-recipe-invocation, so the argv it builds follows the script
 * wherever it runs from. Pinning the install path here instead would let the
 * expectation pass while the argv named a file that does not exist. */
const codexSessionPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-codex-session", import.meta.url),
);
const casesDirectory = fileURLToPath(
  new URL("../../../schema/fixtures/recipe-invocation/cases/", import.meta.url),
);

type TuiHarness = "claude" | "codex";

interface InvocationDescriptor {
  harness: TuiHarness | "chat";
  /** Chat only: the provider whose adapter the boot pins via BLITZ_AGENT.
   * Unused guest-side — the guest consumes invocation.env, never the
   * descriptor — but typed so the corpus shape stays honest. */
  agentProvider?: string;
  model?: string;
  effort?: string;
}

interface InvocationCase {
  name: string;
  descriptor: InvocationDescriptor;
  envBytes: string;
  promptBytes: string;
}

function caseNames(): string[] {
  return readdirSync(casesDirectory).sort();
}

function loadCase(name: string): InvocationCase {
  const caseDir = join(casesDirectory, name);
  // SAFETY: The recipe-invocation fixtures are trusted local test data
  // authored to the InvocationDescriptor shape; the control-plane producer
  // test parses the same descriptor from the same corpus.
  const descriptor = JSON.parse(
    readFileSync(join(caseDir, "invocation.json"), "utf8"),
  ) as InvocationDescriptor;
  return {
    name,
    descriptor,
    envBytes: readFileSync(join(caseDir, "invocation.env"), "utf8"),
    promptBytes: readFileSync(join(caseDir, "prompt.txt"), "utf8"),
  };
}

function tuiCases(): InvocationCase[] {
  return caseNames()
    .map(loadCase)
    .filter(({ descriptor }) => descriptor.harness !== "chat");
}

function chatCases(): InvocationCase[] {
  return caseNames()
    .map(loadCase)
    .filter(({ descriptor }) => descriptor.harness === "chat");
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBash(args: string[], extraEnv: { name: string; value: string }[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const { name, value } of extraEnv) env[name] = value;
    const child = spawn("bash", args, { env });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) =>
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr }),
    );
  });
}

/** Runs the shared parser exactly the way blitz-term does — source the helper,
 * call recipe_invocation_load — and prints the four results NUL-separated so
 * the assertion is byte-exact. Exit 3 marks "no invocation to load". */
const PARSE_SNIPPET = [
  "set -euo pipefail",
  '. "$1"',
  'if recipe_invocation_load "$2"; then',
  "  printf '%s\\0' \"$RECIPE_HARNESS\" \"$RECIPE_MODEL\" \"$RECIPE_EFFORT\" \"$RECIPE_PROMPT\"",
  "else",
  "  exit 3",
  "fi",
].join("\n");

function runParser(recipeDir: string): Promise<RunResult> {
  return runBash(["-c", PARSE_SNIPPET, "bash", helperPath, recipeDir], []);
}

/** Stands in for tmux: per-session-name existence markers, and the argv of
 * the last new-session/attach-session recorded NUL-separated. blitz-term
 * execs tmux, so the recording is the observable outcome of a run. */
const TMUX_STUB = `#!/usr/bin/env bash
set -eu
verb="" target="" prev=""
for arg in "$@"; do
  case "$prev" in
    -t|-s) target=\${arg#=} ;;
  esac
  case "$arg" in
    has-session|new-session|attach-session) verb=$arg ;;
  esac
  prev=$arg
done
case "$verb" in
  has-session)
    [ -e "$TMUX_STUB_STATE/session-$target" ]
    ;;
  new-session)
    printf '%s\\0' "$@" >"$TMUX_STUB_STATE/new-session-argv"
    : >"$TMUX_STUB_STATE/session-$target"
    ;;
  attach-session)
    printf '%s\\0' "$@" >"$TMUX_STUB_STATE/attach-session-argv"
    ;;
  *)
    exit 9
    ;;
esac
`;

interface TermBox {
  stateDir: string;
  recipeDir: string;
  binDir: string;
}

function makeTermBox(): TermBox {
  const stateDir = mkdtempSync(join(tmpdir(), "recipe-term-"));
  const recipeDir = join(stateDir, "recipe");
  mkdirSync(recipeDir);
  const binDir = join(stateDir, "stub-bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "tmux"), TMUX_STUB);
  chmodSync(join(binDir, "tmux"), 0o755);
  return { stateDir, recipeDir, binDir };
}

function plant(box: TermBox, invocation: InvocationCase): void {
  writeFileSync(join(box.recipeDir, "invocation.env"), invocation.envBytes);
  writeFileSync(join(box.recipeDir, "prompt.txt"), invocation.promptBytes);
}

function runTerm(box: TermBox, args: string[]): Promise<RunResult> {
  return runBash(
    [blitzTermPath, ...args],
    [
      { name: "PATH", value: `${box.binDir}:${process.env.PATH ?? ""}` },
      { name: "BLITZ_STATE_DIR", value: box.stateDir },
      { name: "TMUX_STUB_STATE", value: box.stateDir },
      // What the ttyd service hands blitz-term on a real box, pinned so the
      // tmux `-e` flags below do not follow the developer's own locale.
      { name: "LANG", value: "C.UTF-8" },
      { name: "LC_ALL", value: "C.UTF-8" },
    ],
  );
}

function recordedArgv(box: TermBox, file: "new-session-argv" | "attach-session-argv"): string[] {
  const raw = readFileSync(join(box.stateDir, file), "utf8");
  const fields = raw.split("\0");
  expect(fields.at(-1)).toBe("");
  return fields.slice(0, -1);
}

function expectPlanted(box: TermBox, planted: boolean): void {
  expect(existsSync(join(box.recipeDir, "invocation.env"))).toBe(planted);
  expect(existsSync(join(box.recipeDir, "prompt.txt"))).toBe(planted);
  expect(existsSync(join(box.recipeDir, "invocation.env.delivered"))).toBe(!planted);
  expect(existsSync(join(box.recipeDir, "prompt.txt.delivered"))).toBe(!planted);
}

/** The `-e` flags carry the tab's own environment into the new session,
 * because a tmux server hands later sessions its own startup snapshot rather
 * than the creating client's environment (blitz-term-credentials.test.ts pins
 * the rule). These boxes have no creds/env.d, so only the locale pair
 * appears — the recipe argv still has to be exact around it. */
function tmuxCreateArgv(session: string): string[] {
  return [
    "-u", "new-session", "-A", "-s", session, "-c", "/workspace",
    "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8",
  ];
}

function harnessCommand(harness: TuiHarness): string[] {
  return harness === "claude"
    ? ["claude", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]
    : [codexSessionPath];
}

/** The flag mapping blitz-term ships, verified against each CLI's --help:
 * claude has `--model <model>` and `--effort <level>`; codex has
 * `-m, --model <MODEL>` and no effort flag, so effort rides the documented
 * `-c <key=value>` config override as model_reasoning_effort. */
function recipeFlags(harness: TuiHarness, descriptor: InvocationDescriptor): string[] {
  const flags: string[] = [];
  if (harness === "claude") {
    if (descriptor.model !== undefined) flags.push("--model", descriptor.model);
    if (descriptor.effort !== undefined) flags.push("--effort", descriptor.effort);
    return flags;
  }
  if (descriptor.model !== undefined) flags.push("-m", descriptor.model);
  if (descriptor.effort !== undefined) {
    flags.push("-c", `model_reasoning_effort=${descriptor.effort}`);
  }
  return flags;
}

describe("recipe invocation shared parser", () => {
  it("pins the shared fixture corpus", () => {
    expect(caseNames()).toEqual(["full", "minimal", "newlines", "quoted-env-value", "quoting"]);
  });

  it("parses every case to the expected HARNESS/MODEL/EFFORT and exact prompt bytes", async () => {
    for (const name of caseNames()) {
      const invocation = loadCase(name);
      const recipeDir = mkdtempSync(join(tmpdir(), "recipe-parse-"));
      writeFileSync(join(recipeDir, "invocation.env"), invocation.envBytes);
      writeFileSync(join(recipeDir, "prompt.txt"), invocation.promptBytes);

      const result = await runParser(recipeDir);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(result.stdout.split("\0"), name).toEqual([
        invocation.descriptor.harness,
        invocation.descriptor.model ?? "",
        invocation.descriptor.effort ?? "",
        invocation.promptBytes,
        "",
      ]);
    }
  });

  it("reports absence instead of inventing an invocation", async () => {
    const empty = mkdtempSync(join(tmpdir(), "recipe-parse-"));
    expect((await runParser(empty)).status).toBe(3);

    const envOnly = mkdtempSync(join(tmpdir(), "recipe-parse-"));
    writeFileSync(join(envOnly, "invocation.env"), "HARNESS='claude'\n");
    expect((await runParser(envOnly)).status).toBe(3);
  });
});

describe("blitz-term recipe delivery", () => {
  it("appends flags and the exact prompt bytes when creating the matching harness, consuming once", async () => {
    for (const invocation of tuiCases()) {
      // SAFETY: tuiCases filters out "chat", leaving the two TUI harnesses.
      const harness = invocation.descriptor.harness as TuiHarness;
      const box = makeTermBox();
      plant(box, invocation);

      const created = await runTerm(box, [harness, "run"]);
      expect(created.status, `${invocation.name}: ${created.stderr}`).toBe(0);
      expect(recordedArgv(box, "new-session-argv"), invocation.name).toEqual([
        ...tmuxCreateArgv(`${harness}-run`),
        ...harnessCommand(harness),
        ...recipeFlags(harness, invocation.descriptor),
        invocation.promptBytes,
      ]);
      expectPlanted(box, false);
    }
  });

  it("delivers only to the first creating session", async () => {
    const box = makeTermBox();
    plant(box, loadCase("minimal"));

    expect((await runTerm(box, ["claude", "first"])).status).toBe(0);
    expect(recordedArgv(box, "new-session-argv").at(-1)).toBe(loadCase("minimal").promptBytes);
    expectPlanted(box, false);

    const second = await runTerm(box, ["claude", "second"]);
    expect(second.status, second.stderr).toBe(0);
    expect(recordedArgv(box, "new-session-argv")).toEqual([
      ...tmuxCreateArgv("claude-second"),
      ...harnessCommand("claude"),
    ]);
  });

  it("never re-injects on attach, even when fresh files appear", async () => {
    const box = makeTermBox();
    const minimal = loadCase("minimal");
    plant(box, minimal);
    expect((await runTerm(box, ["claude", "same"])).status).toBe(0);

    plant(box, minimal);
    const attach = await runTerm(box, ["claude", "same"]);
    expect(attach.status, attach.stderr).toBe(0);
    expect(recordedArgv(box, "new-session-argv")).toEqual([
      ...tmuxCreateArgv("claude-same"),
      ...harnessCommand("claude"),
    ]);
    // The re-planted files sit untouched for a genuinely new session to take.
    expect(existsSync(join(box.recipeDir, "invocation.env"))).toBe(true);
    expect(existsSync(join(box.recipeDir, "prompt.txt"))).toBe(true);
  });

  it("never consumes in ro mode", async () => {
    const box = makeTermBox();
    plant(box, loadCase("minimal"));

    // No session to observe: blitz-term exits 3 without touching the files.
    expect((await runTerm(box, ["claude", "obs", "ro"])).status).toBe(3);
    expectPlanted(box, true);

    // With a live session the observer attaches read-only; still no consume.
    writeFileSync(join(box.stateDir, "session-claude-obs"), "");
    const observed = await runTerm(box, ["claude", "obs", "ro"]);
    expect(observed.status, observed.stderr).toBe(0);
    expect(recordedArgv(box, "attach-session-argv")).toEqual([
      "-u",
      "attach-session",
      "-r",
      "-t",
      "=claude-obs",
    ]);
    expectPlanted(box, true);
  });

  it("never consumes a mismatched or chat harness", async () => {
    // A claude invocation is not for a codex session.
    const crossed = makeTermBox();
    plant(crossed, loadCase("minimal"));
    expect((await runTerm(crossed, ["codex", "run"])).status).toBe(0);
    expect(recordedArgv(crossed, "new-session-argv")).toEqual([
      ...tmuxCreateArgv("codex-run"),
      ...harnessCommand("codex"),
    ]);
    expectPlanted(crossed, true);

    // HARNESS=chat belongs to the bootstrap chat sender, never to blitz-term.
    for (const invocation of chatCases()) {
      for (const harness of ["claude", "codex"] as const) {
        const box = makeTermBox();
        plant(box, invocation);
        const result = await runTerm(box, [harness, "run"]);
        expect(result.status, `${invocation.name}: ${result.stderr}`).toBe(0);
        expect(recordedArgv(box, "new-session-argv"), invocation.name).toEqual([
          ...tmuxCreateArgv(`${harness}-run`),
          ...harnessCommand(harness),
        ]);
        expectPlanted(box, true);
      }
    }
  });
});
