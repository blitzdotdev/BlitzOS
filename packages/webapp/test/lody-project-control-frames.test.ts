/**
 * Browser-side conformance for the local-project registration contract
 * (`packages/schema/fixtures/lody-project-registration/`, CLAUDE.md's
 * cross-runtime rule).
 *
 * The box registrar is the other producer of these payloads and is pinned by
 * `packages/box/guest-tests/test/lody-projects-registration.test.ts`. This is
 * the half that runs in a tab: `sendProjectControl` posts the request to
 * `/lody/project` and parses the answer with LODY'S OWN response union, and
 * `local-bridge.ts` builds the positional `localProjects.*` helpers Electron's
 * service defines. Both are asserted against the SAME captured corpus, so the
 * two producers cannot drift apart without one of these two files failing.
 *
 * It needs no daemon and gates every merge, which is the point: the daemon-backed
 * suites skip on CI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProjectControlRequestSchema } from "@lody/shared/message-schemas";
import { createLodyLocalBridge } from "../src/lody/local-bridge.js";
import { sendProjectControl } from "../src/lody/rpc-client.js";
import { repoRoot } from "./lody-daemon-harness.js";

const CORPUS = join(repoRoot(), "packages/schema/fixtures/lody-project-registration");

function fixture(relative: string): Record<string, unknown> {
  // SAFETY: every file in the corpus is a JSON object; a malformed one fails
  // here, which is what pinning it is for.
  return JSON.parse(readFileSync(join(CORPUS, relative), "utf8")) as Record<string, unknown>;
}

const MACHINE_ID = String(fixture("request/list.json").machineId);

/**
 * Answers `/lody/platform` with the captured catalog and every POST with
 * `reply`, recording the request bodies.
 *
 * The platform door is here because the bridge's positional helpers resolve the
 * box's machineId from it — see `resolveMachineId` in `local-bridge.ts`. Serving
 * the SAME catalog the corpus was captured against is what makes the recorded
 * `machineId` in each request comparable to the fixture.
 */
function stubFetch(reply: unknown): { fetchImpl: typeof fetch; sent: unknown[] } {
  const sent: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body =
      String(url).endsWith("/platform")
        ? fixture("response/platform-catalog.json")
        : (() => {
            sent.push(JSON.parse(String(init?.body)) as unknown);
            return reply;
          })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const endpoints = (fetchImpl: typeof fetch) => ({
  rpcUrl: "https://box.invalid/lody/rpc",
  controlUrl: "https://box.invalid/lody/control",
  projectUrl: "https://box.invalid/lody/project",
  platformUrl: "https://box.invalid/lody/platform",
  fetchImpl,
});

describe("local-project control frames", () => {
  it("accepts every request in the corpus against Lody's own request union", () => {
    for (const name of ["request/list.json", "request/add.json"]) {
      expect(LocalProjectControlRequestSchema.safeParse(fixture(name)).success).toBe(true);
    }
    // And REFUSES an add carrying `githubRepoFullName`, which is the mistake
    // §6.4's wording invites: the field belongs on `ProjectRef`, not on the
    // registration request, and the schema is `.strict()`.
    expect(
      LocalProjectControlRequestSchema.safeParse({
        ...fixture("request/add.json"),
        githubRepoFullName: "blitzdotdev/wt-probe",
      }).success,
    ).toBe(false);
  });

  it("posts a list request and reads back an empty workspace list", async () => {
    const { fetchImpl, sent } = stubFetch(fixture("response/list-empty.json"));
    const response = await sendProjectControl(endpoints(fetchImpl), {
      type: "local-project/list",
      machineId: MACHINE_ID,
    });
    expect(sent[0]).toEqual(fixture("request/list.json"));
    expect(response.ok).toBe(true);
    // `{ workspaces: [] }` and NOT a workspace with no projects. A fresh box is
    // every box on its first boot, so this is the shape that runs first.
    if (response.ok) expect(response.result).toEqual({ workspaces: [] });
  });

  it("reads a project list, an add result and a refusal", async () => {
    const listed = stubFetch(fixture("response/list-one-project.json"));
    const list = await sendProjectControl(endpoints(listed.fetchImpl), {
      type: "local-project/list",
      machineId: MACHINE_ID,
    });
    expect(list.ok).toBe(true);

    const added = stubFetch(fixture("response/add.json"));
    const add = await sendProjectControl(endpoints(added.fetchImpl), {
      type: "local-project/add",
      machineId: MACHINE_ID,
      rootPath: "/workspace/wt-probe",
    });
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect((add.result as { localProjectId: string }).localProjectId).toBe(
        (fixture("response/add-repeat.json").result as { localProjectId: string }).localProjectId,
      );
    }

    const refused = stubFetch(fixture("response/add-refused-path-invalid.json"));
    const refusal = await sendProjectControl(endpoints(refused.fetchImpl), {
      type: "local-project/add",
      machineId: MACHINE_ID,
      rootPath: "/workspace/missing",
    });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.error).toBe("path_invalid");
  });

  it("builds the git-state request from the positional helper and unwraps its result", async () => {
    const { fetchImpl, sent } = stubFetch(fixture("response/git-state-github-remote.json"));
    const bridge = createLodyLocalBridge({ ...endpoints(fetchImpl), syncUrl: "wss://box.invalid/lody/sync" });
    const result = await bridge.ipc.invoke(
      "localProjects.getGitState",
      "lw_4232972aaa2f498ba29fe7e52cb0d928",
      "local-project-5c929c9ed93542aaa69bc27e",
    );
    // Electron's service sends the same three fields and no more
    // (`apps/electron/src/main/ipc/services/local-projects-ipc.ts`), and the
    // request union is `.strict()`, so an extra one is a 400 from the box.
    expect(sent[0]).toEqual({
      type: "local-project/git-state",
      machineId: MACHINE_ID,
      workspaceId: "lw_4232972aaa2f498ba29fe7e52cb0d928",
      localProjectId: "local-project-5c929c9ed93542aaa69bc27e",
    });
    // The three things §6.4 depends on, unwrapped to the RESULT the vendored
    // callers read rather than the envelope.
    const state = result as { githubRepoFullName: string; branches: string[]; currentBranch: string };
    expect(state.githubRepoFullName).toBe("blitzdotdev/wt-probe");
    expect(state.branches).toContain("main");
    expect(state.currentBranch).toBe("main");
    bridge.dispose();
  });
});
