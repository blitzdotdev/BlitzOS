import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_SOURCE,
  createCockpitAssetSet,
  managedFileId,
  uploadManagedAssets,
} from "../scripts/build-blitzdev.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cockpitFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "blitz-cockpit-assets-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "index.html"), "<main>cockpit</main>");
  await writeFile(path.join(directory, "assets", "index-12345678.js"), "export default 1;");
  await writeFile(path.join(directory, "assets", "index-12345678.css"), "main{display:block}");
  return directory;
}

describe("managed cockpit assets", () => {
  it("builds a deterministic manifest with normalized paths and activates index last", async () => {
    const directory = await cockpitFixture();
    const first = await createCockpitAssetSet(directory);
    const second = await createCockpitAssetSet(directory);

    expect(first).toEqual(second);
    expect(first.files.map(({ logicalPath }) => logicalPath)).toEqual([
      "/assets/index-12345678.css",
      "/assets/index-12345678.js",
      "/index.html",
    ]);
    expect(first.files.map(({ mediaType }) => mediaType)).toEqual([
      "text/css; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/html; charset=utf-8",
    ]);
    expect(first.files.every(({ releaseId }) => releaseId === first.releaseId)).toBe(true);
  });

  it("inserts, skips identical content, replaces changed content, and verifies every row", async () => {
    const directory = await cockpitFixture();
    const rows = new Map<string, Record<string, unknown>>();
    const physicalObjects: string[] = [];
    const multipartContentTypes: Array<string | null> = [];
    const access = { base: "https://managed.invalid/api/v1/projects/probe", token: "agent-test-token" };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const view = /\/exec\/blitz_files\/view\/([^/]+)$/u.exec(url.pathname);
      if (view !== null) {
        const row = rows.get(decodeURIComponent(view[1]!));
        return row === undefined ? new Response("missing", { status: 404 }) : Response.json(row);
      }
      const insert = url.pathname.endsWith("/exec_write/blitz_files/insert");
      const edit = /\/exec_write\/blitz_files\/edit\/([^/]+)$/u.exec(url.pathname);
      if (!insert && edit === null) return new Response("unexpected route", { status: 500 });
      multipartContentTypes.push(new Headers(init?.headers).get("content-type"));
      const form = init?.body as FormData;
      const payload = JSON.parse(String(form.get("@jsonPayload"))) as {
        values?: Record<string, unknown>;
        object?: string;
        media_type?: string;
        size_bytes?: number;
        sha256?: string;
        release_id?: string;
      };
      const values = payload.values ?? payload;
      const id = insert ? String(values.id) : decodeURIComponent(edit![1]!);
      const previous = rows.get(id) ?? {};
      const physical = `physical-${physicalObjects.length}-${(form.get("@filePayload") as File).name}`;
      physicalObjects.push(physical);
      rows.set(id, { ...previous, ...values, object: physical });
      return Response.json(rows.get(id));
    };

    const first = await createCockpitAssetSet(directory);
    await expect(uploadManagedAssets(first, access, "project-password", { fetcher })).resolves.toEqual({
      inserted: 3,
      replaced: 0,
      skipped: 0,
      verified: 3,
    });
    await expect(uploadManagedAssets(first, access, "project-password", { fetcher })).resolves.toEqual({
      inserted: 0,
      replaced: 0,
      skipped: 3,
      verified: 3,
    });
    await writeFile(path.join(directory, "index.html"), "<main>changed</main>");
    const changed = await createCockpitAssetSet(directory);
    await expect(uploadManagedAssets(changed, access, "project-password", { fetcher })).resolves.toEqual({
      inserted: 0,
      replaced: 1,
      skipped: 2,
      verified: 3,
    });

    expect(physicalObjects).toHaveLength(4);
    expect(new Set(physicalObjects)).toHaveLength(4);
    expect(multipartContentTypes).toEqual([null, null, null, null]);
    expect(rows.get(managedFileId("cockpit", "/index.html"))).toMatchObject({
      kind: "cockpit",
      logical_path: "/index.html",
      sha256: changed.files.at(-1)?.sha256,
    });
  });

  it("emits logical lookup, getFileObject streaming, cache rules, and API-first SPA precedence", () => {
    expect(WORKER_SOURCE).toContain("FROM blitz_files WHERE kind = ? AND logical_path = ? LIMIT 1");
    expect(WORKER_SOURCE).toContain('db.getFileObject("blitz-files/" + row.object)');
    expect(WORKER_SOURCE).toContain('"public,max-age=31536000,immutable"');
    expect(WORKER_SOURCE).toContain('app.get("/assets/*"');
    expect(WORKER_SOURCE).toContain('app.get("/"');
    expect(WORKER_SOURCE.indexOf("installControlPlaneRoutes")).toBeLessThan(WORKER_SOURCE.indexOf('app.get("/assets/*"'));
    expect(WORKER_SOURCE).toContain("isApiPath(c.req.path)");
  });
});
