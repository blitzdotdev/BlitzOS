import "fake-indexeddb/auto";

/**
 * The second canary dogfood finding, against a real daemon
 * (plans/LODY-RUNTIME-DESIGN.md §12.4).
 *
 * The report: clicking "Sign in with Claude" opens a popup that says
 * "Preparing Claude sign-in…" and never becomes anything else.
 *
 * The cause was one missing header. `machine/acp-authenticate` runs
 * `claude auth login --claudeai`, which prints its authorization URL in about a
 * second and then BLOCKS on stdin waiting for the member to paste the code back.
 * The URL travels in a `machine/acp-authentication-progress` response emitted
 * while that process is still running — and the daemon only emits a response
 * early if the request asked for its NDJSON stream with
 * `Accept: application/x-ndjson` (`apps/cli/src/lib/local-session-control.ts:33`).
 * The browser sent no `Accept`, and `blitz-lody-bridge` replaced the browser's
 * headers with a fixed set that had none either, so every call took the buffered
 * path: one JSON envelope, written after the flow the member was waiting on had
 * already finished. The popup could not be navigated because nothing arrived.
 *
 * So the assertion that matters is an ORDERING one, and it is the only one that
 * distinguishes the fix from the bug: the authorization frame must reach the
 * browser WHILE the POST that carries it is still open. A test that merely
 * checked "the frames are all there at the end" passes on the broken chain.
 *
 * NOTHING HERE IS PAID and nothing here talks to Anthropic. `runtimeOverrides`
 * names a script instead of the real `claude`, the same trick
 * `lody-worktree-session.test.ts` uses to exercise a session create for free.
 * The script prints the exact bytes claude 2.1.228 prints (measured), then waits
 * on stdin exactly as claude does, so the daemon's own output parser
 * (`apps/cli/src/agent/acp-authentication-output.ts`) is the one under test.
 *
 * The suite skips with no `lody` bundle installed, which is CI. The two halves
 * that must gate a merge are pinned without a daemon:
 * `box/guest-tests/test/lody-bridge-control-stream.test.ts` (the bridge forwards
 * the negotiation and pipes the frames) and `lody-session-control-stream.test.ts`
 * (the browser reads them as they land).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { getMachineFlockDocId, machineFlockKeys } from "@lody/shared";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { sendSessionControl } from "../src/lody/rpc-client.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { createLodyRuntime, type LodyRuntimeHandle } from "../src/lody/runtime.js";
import type { LodySessionControlMessage } from "../src/lody/wire-types.js";
import { HARNESS_BOOT_TIMEOUT_MS, lodyDaemonAvailable, startLodyHarness, type LodyHarness } from "./lody-daemon-harness.js";

/** What claude 2.1.228 prints on stdout for `auth login --claudeai`, with a
 * placeholder challenge. Captured on 2026-08-31 by running the real binary
 * headless with a scratch HOME; the daemon's parser accepts a `claude.com` or
 * `claude.ai` URL whose path contains `/oauth/`
 * (`acp-authentication-output.ts:24`). */
const AUTHORIZATION_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&code_challenge=r8PNdZ3k3_yQGoZv9-pKzKnKwrEqyRoBtx4-fDwsonQ&code_challenge_method=S256";

/**
 * `claude auth login --claudeai`, reduced to what the flow depends on.
 *
 * Three properties, all of them load-bearing: it prints the URL immediately, it
 * does NOT exit afterwards, and it finishes only when a line arrives on stdin.
 * The middle one is the whole test — a script that exited would let the buffered
 * path look correct.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" != "auth" ] || [ "$2" != "login" ]; then
  echo "unexpected argv: $*" >&2
  exit 64
fi
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: ${AUTHORIZATION_URL}"
printf 'Paste code here if prompted > '
read -r code
[ -n "$code" ] || exit 1
exit 0
`;

/** The `authorizationCode` the panel would submit. Any non-empty line ends the
 * script; the value is only checked for having crossed the wire. */
const AUTHORIZATION_CODE = "test-authorization-code";

function progressStatuses(responses: readonly LodySessionControlMessage[]): string[] {
  return responses
    .filter((response) => response.type === "machine/acp-authentication-progress")
    .map((response) => String(response.status));
}

describe.skipIf(!lodyDaemonAvailable())("machine/acp-authenticate over the real chain", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  let scratch: string;
  let fakeClaude: string;

  beforeAll(async () => {
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error(`no platform snapshot\n${harness.daemonLog()}`);
    snapshot = read;
    scratch = mkdtempSync(join(tmpdir(), "la-"));
    fakeClaude = join(scratch, "claude");
    writeFileSync(fakeClaude, FAKE_CLAUDE);
    chmodSync(fakeClaude, 0o755);

    handle = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
      installGlobals: false,
    });
    const flockDocId = getMachineFlockDocId(handle.runtime.workspaceId, snapshot.machineId);
    const flock = await handle.runtime.repo.openFlockDoc(flockDocId);
    await flock.syncOnce();
    const key = machineFlockKeys.agentConfig(BLITZ_CLAUDE_CONFIG_ID) as readonly string[];
    await handle.runtime.writer.flockRowPutIfAbsent(flockDocId, key, {
      id: BLITZ_CLAUDE_CONFIG_ID,
      machineId: snapshot.machineId,
      name: "Claude Code",
      cliType: "builtin",
      agentType: "claude",
      env: {},
      runtimeOverrides: { claudeCodeExecutable: fakeClaude },
    });
    await flock.syncOnce();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await handle?.dispose();
    await harness?.stop();
  });

  /** One `machine/acp-authenticate`, with only the fields the daemon's current
   * `.strict()` source schema accepts. Launch details come from the persisted
   * config row above rather than crossing the control request. */
  function authenticate(fields: Record<string, string>): LodySessionControlMessage {
    return {
      type: "machine/acp-authenticate",
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      ...fields,
    } as unknown as LodySessionControlMessage;
  }

  it("delivers the authorization URL while the request is still open", async () => {
    const requestId = "auth-stream-1";
    const streamed: LodySessionControlMessage[] = [];
    let settled = false;

    const started = sendSessionControl(
      harness.endpoints,
      authenticate({ requestId, action: "start", configId: BLITZ_CLAUDE_CONFIG_ID }),
      (response) => streamed.push(response),
    ).finally(() => {
      settled = true;
    });

    const deadline = Date.now() + 60_000;
    const authorization = await (async () => {
      for (;;) {
        const found = streamed.find(
          (response) =>
            response.type === "machine/acp-authentication-progress" &&
            response.status === "authorization",
        );
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(`no authorization frame arrived\n${harness.daemonLog()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();

    // THE ASSERTION. On the buffered chain this is `true` — the batch cannot be
    // read until the login process exits, and the login process is waiting for
    // the member who is waiting for this frame.
    expect(settled).toBe(false);
    expect(authorization.requestId).toBe(requestId);
    expect(authorization.authorizationUrl).toBe(AUTHORIZATION_URL);
    // Claude's own arm of the parser marks the flow as taking a pasted code,
    // which is what makes the panel render its input.
    expect(authorization.acceptsAuthorizationCode).toBe(true);

    // The panel's next move, on its own request. The daemon writes the code to
    // the login process's stdin, which is what lets the script exit.
    const submitted = await sendSessionControl(
      harness.endpoints,
      authenticate({
        requestId: "auth-stream-1-code",
        action: "submit-code",
        authenticationRequestId: requestId,
        authorizationCode: AUTHORIZATION_CODE,
      }),
      () => undefined,
    );
    if (!submitted.ok) throw new Error(`submit-code failed: ${submitted.error}\n${harness.daemonLog()}`);
    const acceptance = submitted.responses.find(
      (response) => response.type === "machine/acp-authenticate_response",
    );
    expect(acceptance?.disposition).toBe("input-accepted");

    const result = await started;
    if (!result.ok) throw new Error(`authenticate failed: ${result.error}\n${harness.daemonLog()}`);
    // `starting` before the spawn, `authorization` from the printed URL,
    // `output` for each chunk of stdout, `authenticated` when the child exits 0.
    const statuses = progressStatuses(result.responses);
    expect(statuses[0]).toBe("starting");
    expect(statuses).toContain("authorization");
    expect(statuses.at(-1)).toBe("authenticated");
    const answer = result.responses.find(
      (response) => response.type === "machine/acp-authenticate_response",
    );
    expect(answer?.success).toBe(true);
    expect(answer?.disposition).toBe("authenticated");
  }, 120_000);

  it("takes the buffered envelope when nothing asks for the stream", async () => {
    // The other side of the negotiation, and the reason the bridge decides
    // rather than relays: a box whose bridge predates this change still answers,
    // it just answers late. `action: 'cancel'` for an id nothing is running
    // under settles immediately, so this costs no waiting either way.
    const body = JSON.stringify(
      authenticate({
        requestId: "auth-buffered",
        action: "cancel",
        authenticationRequestId: "not-running",
      }),
    );
    const post = async (accept: string | null): Promise<string> => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-lody-local-control": "1",
      };
      if (accept !== null) headers.accept = accept;
      const response = await fetch(harness.endpoints.controlUrl, { method: "POST", headers, body });
      const contentType = response.headers.get("content-type") ?? "";
      await response.text();
      return contentType;
    };
    expect(await post("application/x-ndjson")).toMatch(/^application\/x-ndjson/u);
    expect(await post(null)).toMatch(/^application\/json/u);
  }, 60_000);
});
