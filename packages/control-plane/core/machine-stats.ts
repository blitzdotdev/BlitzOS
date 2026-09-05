import { changed } from "./db.js";
import { HttpError, isNumber, isRecord, readJson, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { MachineStatsRequest } from "./wire.js";

// The machine-stats contract uses packages/schema/fixtures/machine-stats/.
// The updater at rootfs/usr/local/libexec/blitz-payload measures the filesystem
// holding its state directory. It posts `{ diskUsedPercent }` here once per
// successful five-minute tick with its box credential. The guest test is
// packages/box/guest-tests/test/machine-stats-conformance.test.ts. Edit the
// accept rule and that test together.

/** The body cap. One integer in one object needs nothing like this much room;
 * the slack is there so a forward-compatible guest can add a field without
 * this route refusing the whole report. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Accepts iff the body is an object whose `diskUsedPercent` is an integer
 * between 0 and 100 inclusive.
 *
 * Everything else is a 400, including a float and a numeric string. A guest
 * that cannot measure its disk must send nothing at all — a wrong number
 * would overwrite the last true one, and the column has no way to say "this
 * figure is a guess". Unknown extra keys are tolerated, because a newer guest
 * reporting more than this control plane knows about must still land its
 * percentage.
 */
export function parseMachineStats(value: JsonValue): MachineStatsRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const percent = value.diskUsedPercent;
  if (!isNumber(percent) || !Number.isInteger(percent)) {
    throw new HttpError(400, "diskUsedPercent must be an integer");
  }
  if (percent < 0 || percent > 100) {
    throw new HttpError(400, "diskUsedPercent must be between 0 and 100");
  }
  return { diskUsedPercent: percent };
}

export function addMachineStatsRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  // Box-authenticated, like every other /workspaces/self/* route: the machine
  // reports on itself, so the row it writes is the one its credential names
  // and no id crosses the wire.
  router.post("/workspaces/self/machine-stats", async (context: CoreContext) => {
    const runtime = runtimeFactory(context);
    const box = await authenticateBox(context.req.raw, runtime.db);
    if (box === null) throw new HttpError(401, "invalid box access token");
    if (box.workspaceId === null) {
      throw new HttpError(403, "only workspace machines report machine stats");
    }
    const input = parseMachineStats(await readJson(context.req.raw, MAX_BODY_BYTES));
    // No `updated_at` bump and no workspace revision bump: a disk figure that
    // moves one point must not wake every poller in the organization, and the
    // next poll carries it anyway.
    await changed(runtime.db, {
      q: `UPDATE machines SET disk_used_percent = ?1, disk_reported_at = ?2
          WHERE id = ?3 RETURNING id`,
      v: [input.diskUsedPercent, Date.now(), box.id],
    });
    return context.body(null, 204);
  });
}
