import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ActorService } from "./actor.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CredentialSource } from "./credentials.js";
import { Journal } from "./journal.js";
import { ActorServer } from "./server.js";
import type { Provider } from "./types.js";

const stateDir = process.env.BLITZ_STATE_DIR;
if (!stateDir) throw new Error("BLITZ_STATE_DIR is required");
const provider = process.env.BLITZ_AGENT;
if (provider !== "claude" && provider !== "codex") throw new Error("BLITZ_AGENT must be claude or codex");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const journal = new Journal(join(stateDir, "journal.db"));
const service = new ActorService(
  journal,
  new CredentialSource(stateDir),
  (name: Provider) => (name === "claude" ? new ClaudeAdapter() : new CodexAdapter()),
  provider,
);
const server = new ActorServer(service);
await server.start();

async function shutdown(): Promise<void> {
  await server.close();
  journal.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
