/**
 * Box-side conformance for the local-project registration contract
 * (`packages/schema/fixtures/lody-project-registration/`, CLAUDE.md's
 * cross-runtime rule).
 *
 * This drives the REAL `/usr/local/libexec/blitz-lody-projects` as a child
 * process against a STAND-IN daemon: a unix socket serving `/project-control`
 * with the captured responses, and a `workspace-catalog.json` carrying the
 * machineId the corpus was captured with. So what is under test is exactly the
 * registrar's own behaviour — which repositories it finds, which requests it
 * sends, and what it does with each answer — with no `lody` bundle installed
 * and no network. It gates every merge.
 *
 * WHY THE SHAPES MATTER MORE THAN THE HAPPY PATH. `LocalProjectAddRequestSchema`
 * is `.strict()`, so one extra field is a 400 from a daemon that is not here to
 * say so; and `local-project/list` answers `{ workspaces: [] }` on a fresh box
 * rather than a workspace with no projects, which is the shape a reader gets
 * wrong first. Both are pinned below against the captured corpus.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REGISTRAR = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-lody-projects", import.meta.url),
);
const CORPUS = fileURLToPath(
  new URL("../../../schema/fixtures/lody-project-registration/", import.meta.url),
);

function fixture(relative: string): Record<string, unknown> {
  // SAFETY: every file in the corpus is a JSON object; a malformed one fails
  // this test loudly, which is the point of pinning it.
  return JSON.parse(readFileSync(join(CORPUS, relative), "utf8")) as Record<string, unknown>;
}

/** The machineId the corpus was captured with. The registrar reads it out of
 * the daemon's own catalog, so the stand-in serves the same one and the request
 * fixtures compare byte-for-byte. */
const MACHINE_ID = String(fixture("request/list.json").machineId);

interface Recorded {
  path: string;
  body: unknown;
}

describe("blitz-lody-projects registration", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const undo of cleanup.splice(0)) undo();
  });

  /**
   * A stand-in daemon on a unix socket.
   *
   * `answer` is asked for each request in order; returning `undefined` means
   * "the corpus has nothing for this", which fails the test rather than
   * inventing a reply.
   */
  function serveProjectControl(
    socketPath: string,
    answer: (request: Recorded, index: number) => unknown,
  ): Recorded[] {
    const seen: Recorded[] = [];
    const server: Server = createHttpServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk) => (body += String(chunk)));
      incoming.on("end", () => {
        const record: Recorded = { path: incoming.url ?? "", body: JSON.parse(body) as unknown };
        seen.push(record);
        const reply = answer(record, seen.length - 1);
        response.writeHead(reply === undefined ? 500 : 200, {
          "content-type": "application/json",
          // The daemon requires this header on the way IN; the registrar sends
          // it, and the assertion below is what keeps it sent.
        });
        response.end(JSON.stringify(reply ?? { ok: false, error: "no_fixture" }));
      });
    });
    server.listen(socketPath);
    cleanup.push(() => server.close());
    return seen;
  }

  /** A data dir shaped like `$LODY_DATA_DIR`: a run dir for the socket and the
   * catalog the machineId comes from. Short, because `sun_path` caps a unix
   * socket at 103 bytes. */
  function makeDataDir(): { dataDir: string; socketPath: string } {
    const dataDir = mkdtempSync(join(tmpdir(), "lp-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    mkdirSync(join(dataDir, "run"), { recursive: true });
    writeFileSync(
      join(dataDir, "workspace-catalog.json"),
      JSON.stringify({ machine: { machineId: MACHINE_ID } }),
    );
    return { dataDir, socketPath: join(dataDir, "run", "lody-oss-control.sock") };
  }

  /** A workspace root with `repos` git repositories and one directory that is
   * not one. `.git` is written as a FILE for one of them, because that is what a
   * repo checked out as a worktree carries and the registrar must accept it. */
  function makeWorkspace(repos: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "lw-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    repos.forEach((name, index) => {
      mkdirSync(join(root, name), { recursive: true });
      if (index === 0) mkdirSync(join(root, name, ".git"));
      else writeFileSync(join(root, name, ".git"), "gitdir: /elsewhere\n");
    });
    mkdirSync(join(root, "not-a-repo"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    return root;
  }

  function runRegistrar(dataDir: string, workspaceRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REGISTRAR], {
        env: {
          ...process.env,
          LODY_PLATFORM: "local",
          LODY_DATA_DIR: dataDir,
          BLITZ_WORKSPACE_ROOT: workspaceRoot,
          BLITZ_LODY_PROJECTS_ONCE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => (output += String(chunk)));
      child.stderr?.on("data", (chunk) => (output += String(chunk)));
      child.once("exit", (code) =>
        code === 0 ? resolve(output) : reject(new Error(`exited ${code}: ${output}`)),
      );
    });
  }

  it("sends the corpus's list and add requests, in that order, on a fresh box", async () => {
    const { dataDir, socketPath } = makeDataDir();
    const workspaceRoot = makeWorkspace(["wt-probe"]);
    const seen = serveProjectControl(socketPath, (_request, index) =>
      index === 0 ? fixture("response/list-empty.json") : fixture("response/add.json"),
    );

    const output = await runRegistrar(dataDir, workspaceRoot);

    expect(seen.map((record) => record.path)).toEqual(["/project-control", "/project-control"]);
    expect(seen[0]?.body).toEqual(fixture("request/list.json"));
    // Same shape as the corpus, with this run's own root path. The FIELD SET is
    // what the strict schema cares about, and it is asserted exactly.
    expect(seen[1]?.body).toEqual({
      ...fixture("request/add.json"),
      rootPath: join(workspaceRoot, "wt-probe"),
    });
    expect(output).toContain(`registered ${join(workspaceRoot, "wt-probe")}`);
  });

  it("skips a directory that is not a repository, and a hidden one", async () => {
    const { dataDir, socketPath } = makeDataDir();
    const workspaceRoot = makeWorkspace(["alpha", "beta"]);
    const seen = serveProjectControl(socketPath, (_request, index) =>
      index === 0 ? fixture("response/list-empty.json") : fixture("response/add.json"),
    );

    await runRegistrar(dataDir, workspaceRoot);

    // Two repos, in sorted order, and nothing else. The `.git` FILE case is
    // `beta`, which is what a repo checked out as a worktree looks like.
    expect(seen.slice(1).map((record) => (record.body as { rootPath: string }).rootPath)).toEqual([
      join(workspaceRoot, "alpha"),
      join(workspaceRoot, "beta"),
    ]);
  });

  it("adds nothing when the daemon already holds the root path", async () => {
    const { dataDir, socketPath } = makeDataDir();
    const workspaceRoot = makeWorkspace(["wt-probe"]);
    const listed = fixture("response/list-one-project.json") as {
      result: { workspaces: { projects: { rootPath: string }[] }[] };
    };
    // The corpus was captured against its own scratch path; point its one
    // project at this run's clone so the registrar's diff has something to hit.
    const project = listed.result.workspaces[0]?.projects[0];
    if (project === undefined) throw new Error("the list corpus has no project");
    project.rootPath = join(workspaceRoot, "wt-probe");
    const seen = serveProjectControl(socketPath, () => listed);

    const output = await runRegistrar(dataDir, workspaceRoot);

    expect(seen).toHaveLength(1);
    expect(output).toContain('"added":[]');
  });

  it("logs a refusal and keeps going", async () => {
    const { dataDir, socketPath } = makeDataDir();
    const workspaceRoot = makeWorkspace(["alpha", "beta"]);
    const seen = serveProjectControl(socketPath, (_request, index) => {
      if (index === 0) return fixture("response/list-empty.json");
      return index === 1 ? fixture("response/add-refused-path-invalid.json") : fixture("response/add.json");
    });

    const output = await runRegistrar(dataDir, workspaceRoot);

    // Three calls: the list, the refused add, and the one after it. A refusal
    // that stopped the pass would leave every later repo unregistered until the
    // next tick, and on a box the later repo is as likely to be the one the
    // member wants.
    expect(seen).toHaveLength(3);
    expect(output).toContain("path_invalid");
    expect(output).toContain(`registered ${join(workspaceRoot, "beta")}`);
  });

  it("does nothing at all before the daemon has written its catalog", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lp-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    mkdirSync(join(dataDir, "run"), { recursive: true });
    const workspaceRoot = makeWorkspace(["wt-probe"]);
    const seen = serveProjectControl(join(dataDir, "run", "lody-oss-control.sock"), () => undefined);

    const output = await runRegistrar(dataDir, workspaceRoot);

    // A boot state, not a failure: the catalog appears when the daemon finishes
    // provisioning its implicit workspace, and the next pass registers.
    expect(seen).toHaveLength(0);
    expect(output).toContain("catalog_unavailable");
  });
});
