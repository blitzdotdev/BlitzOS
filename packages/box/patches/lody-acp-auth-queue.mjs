#!/usr/bin/env node
// TRANSITION STATUS (2026-09-04). The image still applies this script to its
// npm lody@0.88.1 artifact until plans/LODY-DAEMON-FROM-TREE.md PR C. The target
// moves this exact start-only rule to the declared message-processor source
// seam; upstream merges follow docs/LODY-MERGE.md and never bump this artifact.
// Gives `machine/acp-authenticate` its own queue chain in the PUBLISHED `lody`
// npm bundle, so an interactive sign-in can be finished.
//
// WHY THIS EXISTS. `MessageProcessor.extractQueueKey` returns `null` for every
// message it does not name, and `ConcurrentQueue.enqueue` maps `null` to the
// single shared chain key `__default__` — where tasks run STRICTLY IN SEQUENCE.
// `machine/acp-authenticate` is one of the unnamed types, and its `start` action
// runs `claude auth login --claudeai`, which prints its authorization URL and
// then BLOCKS on stdin until the member pastes the code back (measured against
// claude 2.1.228: no loopback callback is bound, so the paste is the only way
// the flow can end).
//
// So the message that carries the pasted code queues behind the login that is
// waiting for it. That is a deadlock, and the daemon says so itself:
//
//   Message still waiting in queue type=machine/acp-authenticate
//   sessionId=N/A queuedFor=10000ms active=1 waiting=0
//
// It resolves only when the login times out 285 s later. `action: 'cancel'` is
// queued behind the same chain, so the Cancel button cannot stop it either.
//
// WHAT THE PATCH DOES. One case, before the `default`:
//
//   case "machine/acp-authenticate":
//     return message.action === "start" ? `acp-auth:${message.agentType}` : null;
//
// A `start` moves onto its own per-agent chain. `submit-code` and `cancel` keep
// the `null` key they already had, and are therefore no longer behind it.
//
// The per-agent chain is not arbitrary: the daemon already refuses a second
// concurrent login for one agent type from `runningByAgentType`
// (`apps/cli/src/agent/acp-authentication.ts`), so serializing starts per agent
// is the rule it already enforces, moved one layer out. Two DIFFERENT agents
// signing in at once now proceed in parallel, which they could not before.
//
// SCOPE. Strictly narrowing: the only messages that change chains are
// `machine/acp-authenticate` starts, which leave a chain they were blocking.
// No message gains a peer it did not already have.
//
// WHY THE GUARD IS NOT A WHOLE-FILE SHA. Two patches now run over the same
// artifact, and a file hash can only pin whichever runs first — the second would
// have to hash its sibling's output and would break whenever that sibling
// changed. So this one pins the two things that are actually load-bearing: the
// installed package's VERSION, and the exact anchor text, at exactly one
// occurrence. A refactor that moves the switch fails here with a count of 0.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-acp-auth-queue.mjs <path to lody/dist/index.js>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.88.1";
const EXPECTED_OCCURRENCES = 1;

/** The tail of `extractQueueKey`'s switch. `extractSessionId` above it ends in
 * the same two cases, so the preview arm is included to make the anchor unique
 * — it is the one line the two functions do not share. */
const FIND = `        case "session/preview-candidate-report":
        case "session/preview-create":
        case "session/preview-revoke":
          return \`session:\${message.sessionId}:preview\`;
        case "session/cancel":
          return null;
        default:
          return null;`;

const REPLACE = `        case "session/preview-candidate-report":
        case "session/preview-create":
        case "session/preview-revoke":
          return \`session:\${message.sessionId}:preview\`;
        case "machine/acp-authenticate":
          return message.action === "start" ? \`acp-auth:\${message.agentType}\` : null;
        case "session/cancel":
          return null;
        default:
          return null;`;

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-acp-auth-queue.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

// `dist/index.js` -> the package root beside it. Read rather than assumed: the
// version is what a bump changes, and it is the first thing to check.
const manifestPath = join(dirname(dirname(target)), "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
  console.error(`lody-acp-auth-queue: cannot read ${manifestPath}: ${String(cause)}`);
  process.exit(1);
}
if (version !== EXPECTED_VERSION) {
  console.error(
    `lody-acp-auth-queue: refusing to patch ${target}.\n` +
      `  expected lody@${EXPECTED_VERSION}, found lody@${String(version)}\n` +
      "  The pinned lody version moved. Re-check whether upstream still queues\n" +
      "  every machine/* message on one chain — if it does not, DELETE this patch\n" +
      "  instead of updating it.",
  );
  process.exit(1);
}

const source = readFileSync(target, "utf8");
if (source.includes('case "machine/acp-authenticate":\n          return message.action')) {
  console.log(`lody-acp-auth-queue: ${target} is already patched.`);
  process.exit(0);
}

const occurrences = source.split(FIND).length - 1;
if (occurrences !== EXPECTED_OCCURRENCES) {
  console.error(
    `lody-acp-auth-queue: expected ${EXPECTED_OCCURRENCES} occurrence of the\n` +
      `  extractQueueKey switch tail in ${target}, found ${occurrences}.\n` +
      "  The message queue's key table moved. Re-audit it before shipping a box:\n" +
      "  without this patch an interactive agent sign-in cannot be completed.",
  );
  process.exit(1);
}

writeFileSync(target, source.split(FIND).join(REPLACE));
console.log(
  `lody-acp-auth-queue: gave machine/acp-authenticate its own queue chain in ${target} (lody@${EXPECTED_VERSION}).`,
);
