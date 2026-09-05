/**
 * Example: mid-turn steering over ACP with the Lody extension contract.
 *
 * "Steering" lets a client deliver a follow-up message to a turn that is still
 * running, instead of waiting for it to finish and sending a fresh
 * `session/prompt`. This is what powers "the user typed something while the
 * agent was still working" — the new message joins the in-flight turn so the
 * agent can adapt immediately (it shines in multi-step / tool-using turns,
 * where the message slots in between tool calls).
 *
 * The wire protocol has three moving parts:
 *
 *   1. The agent advertises `agentCapabilities._meta.lody.steering` with
 *      `transport: "prompt"` in its `initialize` response.
 *   2. The client sends a standard `session/prompt` while a turn is running,
 *      correlating it with a unique `_meta.lody.steer.id`.
 *   3. Before forwarding the steered output, the agent sends
 *      `_lody/session/steer_applied` with that id.
 *
 * This example launches the agent as a subprocess, starts a deliberately
 * long-running prompt, and — as soon as the agent begins streaming — injects a
 * steering message and prints the outcome. All agent output is streamed to
 * stdout so you can watch the turn change course.
 *
 * Run (build the agent first so `dist/index.js` exists):
 *
 *   npm run build
 *   node examples/steering.ts
 *
 * (Node < 22.18 needs `node --experimental-strip-types examples/steering.ts`.)
 *
 * Override the prompts with the PROMPT / STEER env vars. Requires the agent to
 * be authenticated, since it talks to the real model.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  LODY_EXTENSION_METHODS,
  type LodyExtensionCapabilities,
  type LodySteerApplied,
} from "acp-extension-core";

// The built agent entry. Run `npm run build` first so this exists.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ENTRY = process.env.AGENT_ENTRY ?? path.join(repoRoot, "dist", "index.js");
const CWD = process.env.CWD ?? process.cwd();

// A deliberately long-running first prompt, and the follow-up injected while it
// is still streaming. Override either via env vars to experiment.
const PROMPT =
  process.env.PROMPT ??
  "Count slowly from 1 to 30, one number per line, with a short sentence of " +
    "commentary after each. Do not stop early.";
const STEER =
  process.env.STEER ?? "Actually stop counting and instead reply with exactly one line: STEERED-OK";

function log(msg: string) {
  process.stderr.write(`\x1b[2m[client]\x1b[0m ${msg}\n`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // An ACP client launches the agent as a subprocess and speaks JSON-RPC over
  // its stdin/stdout. stderr is inherited so the agent's own logs stay visible.
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  child.on("error", (err) => {
    log(`failed to spawn agent (${AGENT_ENTRY}): ${err}`);
  });

  try {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );

    // Resolves the first time the agent streams assistant text — our signal that
    // the turn is genuinely underway and therefore steerable.
    let signalFirstOutput = () => {};
    const firstOutput = new Promise<void>((resolve) => (signalFirstOutput = resolve));
    let expectedSteerId: string | undefined;
    let signalSteerApplied = () => {};
    const steerApplied = new Promise<void>((resolve) => (signalSteerApplied = resolve));

    const connection = acpClient({ name: "steering-example" })
      .onNotification(methods.client.session.update, (ctx) => {
        const update = ctx.params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          process.stdout.write(update.content.text);
          signalFirstOutput();
        }
      })
      .onNotification<LodySteerApplied>(
        LODY_EXTENSION_METHODS.sessionSteerApplied,
        (params) => params as LodySteerApplied,
        (ctx) => {
          if (ctx.params.steerId === expectedSteerId) signalSteerApplied();
        },
      )
      // Auto-approve permission prompts so the turn is never blocked on us.
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        const options = ctx.params.options;
        const option = options.find((o) => o.kind === "allow_once") ?? options[0];
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      })
      // Minimal file-system stubs; the example prompts don't touch files.
      .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
      .onRequest(methods.client.fs.writeTextFile, () => ({}))
      .connect(stream);

    try {
      const agent = connection.agent;

      // 1. Initialize and confirm the agent advertises prompt-transport steering.
      const init = await agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      const capabilities = init.agentCapabilities?._meta?.lody as
        LodyExtensionCapabilities | undefined;
      if (capabilities?.steering?.transport !== "prompt") {
        throw new Error("agent does not advertise prompt-transport steering");
      }
      log("agent advertises prompt-transport steering");

      // 2. Open a session.
      const { sessionId } = await agent.request(methods.agent.session.new, {
        cwd: CWD,
        mcpServers: [],
      });
      log(`session: ${sessionId}`);

      // 3. Start a long turn, but DON'T await it yet — we need it in flight so we
      //    can steer it. Its output streams through the notification handler above.
      log(`prompt: ${PROMPT}`);
      process.stdout.write("\n----- agent output -----\n");
      const turn = agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: PROMPT }],
      });

      // 4. Once the turn is producing output, inject the follow-up. Wait for the
      //    first streamed chunk (with a fallback) plus a beat, so the steer clearly
      //    lands mid-turn.
      await Promise.race([firstOutput, delay(5000)]);
      await delay(1000);

      process.stdout.write("\n");
      log(`steer: ${STEER}`);
      const steerId = randomUUID();
      expectedSteerId = steerId;
      const steerRequest: PromptRequest = {
        sessionId,
        prompt: [{ type: "text", text: STEER }],
        _meta: { lody: { steer: { id: steerId } } },
      };
      const steeredTurn = agent.request<PromptResponse, PromptRequest>(
        methods.agent.session.prompt,
        steerRequest,
      );
      await steerApplied;
      log(`steer applied: ${steerId}`);
      const steeredResponse = await steeredTurn;
      log(`steered turn stopReason: ${steeredResponse.stopReason}`);

      // 5. Await the original turn. The correlated prompt already reshaped its
      //    output above and has its own standard prompt response.
      const response = await turn;
      log(`original turn stopReason: ${response.stopReason}`);
      process.stdout.write("\n----- end of agent output -----\n");
    } finally {
      connection.close();
    }
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
