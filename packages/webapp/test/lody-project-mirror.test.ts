/**
 * What the composer's "Select a project" list is actually built from.
 *
 * `buildVisibleLocalProjectIndex` (`lib/visible-local-project-index.ts:69`)
 * walks `machineMeta.localProjects` and NOTHING else — not the machine Flock,
 * not `local-project/list`. The daemon writes only the Flock row when a project
 * is added (`local-project-meta.ts:82`), so on a box the ONE thing that puts a
 * registered repository on that list is `mirrorLocalProjectsToMachineMeta`.
 *
 * That made a partial read of the Flock a DELETION: the mirror used to write the
 * rows it had just read as the whole field, and `syncOnce` is best-effort, so a
 * room that had exchanged half its rows published half the member's repositories
 * and nothing re-read it until the tab was reloaded. This pins the merge that
 * closed it, against Lody's own row reader rather than a copy of it.
 */
import { describe, expect, it } from "vitest";
import { getMachineRoomId, machineFlockKeys } from "@lody/shared";
import { mirrorLocalProjectsToMachineMeta } from "../src/lody/local-projects.js";
import type {
  LodyDocMetaSnapshot,
  LodyFlockDocHandle,
  LodyWorkspaceRuntime,
} from "../src/lody/runtime.js";
import type { JsonObject, JsonValue } from "@blitzos/schema";

const WORKSPACE_ID = "lw_4232972aaa2f498ba29fe7e52cb0d928";
const MACHINE_ID = "1e3dcfd5-2927-415c-8976-6d00322d2818";

/** One `localProject` Flock row, shaped as `normalizeLocalProjectMeta`
 * (`machine-flock.ts:1233`) requires — anything less is dropped by their parser,
 * which is the point of building rows rather than a map. */
function projectRow(id: string, name: string): { key: readonly unknown[]; value: JsonValue } {
  return {
    // SAFETY: `machineFlockKeys.localProject` is Lody's own key builder for this
    // family; the vendor type seam erases both its parameter and its return type.
    key: machineFlockKeys.localProject(id) as readonly unknown[],
    value: { id, name, rootPath: `/workspace/${name}`, createdAtMs: 1_788_000_000_000 },
  };
}

/** A runtime whose Flock answers `rows` and whose machine room already holds
 * `mirrored`. Records the patch the mirror writes. */
function stubRuntime(
  rows: readonly { key: readonly unknown[]; value: JsonValue }[],
  mirrored: JsonObject | undefined,
): { runtime: LodyWorkspaceRuntime; written: JsonObject[] } {
  const written: JsonObject[] = [];
  const handle: LodyFlockDocHandle = {
    // SAFETY: `readMachineFlockRowsFromFlock` needs `scan()` and nothing else
    // (`machine-flock.ts:508`); `LodyFlockBody` is this package's opaque name
    // for whatever it is handed, so the cast asserts no structure of its own.
    flock: { scan: () => rows } as unknown as LodyFlockDocHandle["flock"],
    syncOnce: async () => undefined,
  };
  const snapshot: LodyDocMetaSnapshot | undefined =
    mirrored === undefined ? undefined : { meta: { localProjects: mirrored }, deleted: false };
  const runtime = {
    workspaceId: WORKSPACE_ID,
    repo: {
      openFlockDoc: async () => handle,
      getDocMeta: async () => snapshot,
    },
    writer: {
      upsertDocMeta: async (_roomId: string, patch: JsonValue | undefined) => {
        written.push(patch as JsonObject);
      },
    },
    // SAFETY: `mirrorLocalProjectsToMachineMeta` calls exactly the four members
    // above; the rest of the runtime is not reachable from it.
  } as unknown as LodyWorkspaceRuntime;
  return { runtime, written };
}

describe("local-project mirror", () => {
  it("publishes every Flock row to the field the picker reads", async () => {
    const { runtime, written } = stubRuntime(
      [projectRow("local-project-a", "alpha"), projectRow("local-project-b", "beta")],
      undefined,
    );

    const ids = await mirrorLocalProjectsToMachineMeta(runtime, MACHINE_ID);

    expect(ids.sort()).toEqual(["local-project-a", "local-project-b"]);
    expect(Object.keys(written[0]?.localProjects as JsonObject).sort()).toEqual([
      "local-project-a",
      "local-project-b",
    ]);
  });

  it("keeps a project a short Flock read did not carry", async () => {
    // The room has exchanged one of the two rows it will eventually hold, and
    // the field already carries both from the previous mount. Publishing the
    // read as the whole field would take `beta` off the picker.
    const { runtime } = stubRuntime([projectRow("local-project-a", "alpha")], {
      "local-project-a": { id: "local-project-a", name: "alpha", rootPath: "/workspace/alpha", createdAtMs: 1 },
      "local-project-b": { id: "local-project-b", name: "beta", rootPath: "/workspace/beta", createdAtMs: 1 },
    });

    const ids = await mirrorLocalProjectsToMachineMeta(runtime, MACHINE_ID);

    expect(ids.sort()).toEqual(["local-project-a", "local-project-b"]);
  });

  it("prefers the Flock's row over the one already mirrored", async () => {
    // The Flock is the daemon's own record, so a renamed or moved project takes
    // its new value rather than the stale mirror's.
    const { runtime, written } = stubRuntime([projectRow("local-project-a", "renamed")], {
      "local-project-a": { id: "local-project-a", name: "alpha", rootPath: "/workspace/alpha", createdAtMs: 1 },
    });

    await mirrorLocalProjectsToMachineMeta(runtime, MACHINE_ID);

    const published = (written[0]?.localProjects as JsonObject)["local-project-a"] as JsonObject;
    expect(published.rootPath).toBe("/workspace/renamed");
  });

  it("writes nothing when the daemon has cleared the field and the Flock is empty", async () => {
    // `removeMachineLocalProject` deletes the WHOLE legacy field once a Flock row
    // is gone (`local-project-meta.ts:129`), which is what makes the merge above
    // safe: there is no per-key resurrection to guard against.
    const { runtime, written } = stubRuntime([], undefined);

    expect(await mirrorLocalProjectsToMachineMeta(runtime, MACHINE_ID)).toEqual([]);
    expect(written).toEqual([]);
  });

  it("writes to the machine room, not the Flock document", async () => {
    const rooms: string[] = [];
    const { runtime } = stubRuntime([projectRow("local-project-a", "alpha")], undefined);
    const recording = {
      ...runtime,
      writer: {
        ...runtime.writer,
        upsertDocMeta: async (roomId: string) => {
          rooms.push(roomId);
        },
      },
    };

    await mirrorLocalProjectsToMachineMeta(recording, MACHINE_ID);

    expect(rooms).toEqual([getMachineRoomId(MACHINE_ID)]);
  });
});
