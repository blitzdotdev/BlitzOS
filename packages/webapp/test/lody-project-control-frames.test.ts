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
import type { JsonObject } from "@blitzos/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalProjectControlRequestSchema } from "@lody/shared/message-schemas";
import { createLodyLocalBridge } from "../src/lody/local-bridge.js";
import {
  readLocalProjectRepoFullName,
  registerWorkspaceRepositories,
} from "../src/lody/local-projects.js";
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

/** `stubFetch`, answering each POST with the next reply in turn. The sweep sends
 * a browse and then one add per repository, so a single canned answer cannot
 * drive it. */
function stubFetchSequence(replies: readonly unknown[]): { fetchImpl: typeof fetch; sent: unknown[] } {
  const sent: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = String(url).endsWith("/platform")
      ? fixture("response/platform-catalog.json")
      : (() => {
          sent.push(JSON.parse(String(init?.body)) as unknown);
          return replies[sent.length - 1] ?? { ok: false, type: "local-project/add", error: "no_fixture", message: "" };
        })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const WORKSPACE_ID = "lw_4232972aaa2f498ba29fe7e52cb0d928";

const endpoints = (fetchImpl: typeof fetch) => ({
  rpcUrl: "https://box.invalid/lody/rpc",
  controlUrl: "https://box.invalid/lody/control",
  projectUrl: "https://box.invalid/lody/project",
  platformUrl: "https://box.invalid/lody/platform",
  fetchImpl,
});

describe("local-project control frames", () => {
  it("accepts every request in the corpus against Lody's own request union", () => {
    for (const name of [
      "request/list.json",
      "request/add.json",
      "request/list-roots.json",
      "request/browse-dir.json",
      "request/browse-dir-page2.json",
    ]) {
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
    const bridge = createLodyLocalBridge({
      ...endpoints(fetchImpl),
      syncUrl: "wss://box.invalid/lody/sync",
      filesBase: "https://box.invalid/workspace/",
    });
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

  it("reads the clone's repository name off that same captured answer", async () => {
    // `readLocalProjectRepoFullName` is what completes a session's `ProjectRef`
    // at the write (`workdir-default.ts` §2b, RAIL-1/WT-TERM-1). It reads the
    // field out of the daemon's answer, so it is pinned against the real
    // capture rather than against a hand-built body.
    const { fetchImpl, sent } = stubFetch(fixture("response/git-state-github-remote.json"));
    const lookup = await readLocalProjectRepoFullName(
      endpoints(fetchImpl),
      MACHINE_ID,
      "lw_4232972aaa2f498ba29fe7e52cb0d928",
      "local-project-5c929c9ed93542aaa69bc27e",
    );

    expect(lookup).toEqual({ answered: true, repoFullName: "blitzdotdev/wt-probe" });
    expect(sent[0]).toEqual({
      type: "local-project/git-state",
      machineId: MACHINE_ID,
      workspaceId: "lw_4232972aaa2f498ba29fe7e52cb0d928",
      localProjectId: "local-project-5c929c9ed93542aaa69bc27e",
    });
  });

  it("sweeps the workspace root and registers every repository the daemon hinted", async () => {
    const { fetchImpl, sent } = stubFetchSequence([
      fixture("response/browse-dir-page1.json"),
      fixture("response/add.json"),
      fixture("response/add.json"),
      fixture("response/browse-dir-page2.json"),
      fixture("response/add.json"),
    ]);

    const added = await registerWorkspaceRepositories(
      endpoints(fetchImpl),
      MACHINE_ID,
      WORKSPACE_ID,
      "/workspace",
    );

    // THE WORKTREE CASE IS `beta`: its `.git` is a FILE, and the daemon hinted
    // `git` for it exactly as for `alpha`'s directory. A sweep that read the
    // hint any other way would leave a workspace of worktrees unregistered,
    // which is the reported defect.
    expect(added).toEqual(["/tmp/lpb/ws/alpha", "/tmp/lpb/ws/beta", "/tmp/lpb/ws/gamma"]);
    // `notes` has no `git` hint, so it is never sent.
    expect(sent).toHaveLength(5);
    expect(sent[0]).toEqual(fixture("request/browse-dir.json"));
    // The second page is asked for with the cursor the first one handed back,
    // and with the same fields otherwise — the request union is `.strict()`.
    expect(sent[3]).toEqual(fixture("request/browse-dir-page2.json"));
    for (const index of [1, 2, 4]) {
      expect(LocalProjectControlRequestSchema.safeParse(sent[index]).success).toBe(true);
    }
  });

  it("skips a directory the workspace already holds", async () => {
    const { fetchImpl, sent } = stubFetchSequence([
      fixture("response/browse-dir-registered.json"),
      fixture("response/add.json"),
      fixture("response/browse-dir-page2.json"),
      fixture("response/add.json"),
    ]);

    const added = await registerWorkspaceRepositories(
      endpoints(fetchImpl),
      MACHINE_ID,
      WORKSPACE_ID,
      "/workspace",
    );

    // `alpha` carries a `registeredProjectId`, so only `beta` and `gamma` cost
    // an add. Re-adding would be harmless — `local-project/add` is idempotent on
    // `rootPath` — but on a box of twenty repos it is twenty POSTs a mount.
    expect(added).toEqual(["/tmp/lpb/ws/beta", "/tmp/lpb/ws/gamma"]);
    expect(sent).toHaveLength(4);
  });

  it("stops at the page it could not read, keeping what it already registered", async () => {
    const { fetchImpl } = stubFetchSequence([
      fixture("response/browse-dir-page1.json"),
      fixture("response/add.json"),
      fixture("response/add.json"),
      fixture("response/add-refused-path-invalid.json"),
    ]);

    // The fourth call is the second page, and it is answered with a refusal. A
    // sweep is best-effort by construction: the box's own registrar and the next
    // mount both cover what this pass missed, so a bad answer must not throw
    // into the surface bootstrap that awaits it.
    await expect(
      registerWorkspaceRepositories(endpoints(fetchImpl), MACHINE_ID, WORKSPACE_ID, "/workspace"),
    ).resolves.toEqual(["/tmp/lpb/ws/alpha", "/tmp/lpb/ws/beta"]);
  });

  it("opens the folder browser at /workspace, not at the daemon's home directory", async () => {
    const { fetchImpl, sent } = stubFetch(fixture("response/list-roots-home.json"));
    const bridge = createLodyLocalBridge({
      ...endpoints(fetchImpl),
      syncUrl: "wss://box.invalid/lody/sync",
      filesBase: "https://box.invalid/workspace/",
    });

    const result = await bridge.ipc.invoke(
      "localProjects.control",
      // SAFETY: the corpus file is a JSON object, which is a `LodyIpcArgument`;
      // `fixture` widens it to `Record<string, unknown>` on the way out.
      fixture("request/list-roots.json") as JsonObject,
    );

    // The request reaches the daemon UNCHANGED — `homeDir` is still the honest
    // answer to "where is this daemon's home", and the daemon keeps its data
    // dir, its skills path and its agent credentials there.
    expect(sent[0]).toEqual(fixture("request/list-roots.json"));
    // What the picker reads is the box's workspace root. Without this the
    // "Add a local project" browser opened on `/var/lib/blitz/home`, which holds
    // the daemon's own state and none of the member's repositories.
    expect(result).toEqual({
      ok: true,
      type: "local-project/list-roots",
      result: { platform: "linux", pathSeparator: "/", homeDir: "/workspace" },
    });
    bridge.dispose();
  });
});
