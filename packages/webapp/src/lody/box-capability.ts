/**
 * Does the box behind these endpoints run the Lody daemon at all?
 * (plans/LODY-SESSIONS.md §13.2, plans/LODY-RUNTIME-DESIGN.md §17.)
 *
 * §13.2 named this gap and left it: `ProviderCapabilities` carries three
 * `*SinceMs` cutoffs and none of them says "this image serves `/lody/*`". The
 * fourth canary dogfood is that gap in the field. A box on a PRE-LODY image has
 * no `/lody/*` door — its gateway falls unknown paths through to dufs, which
 * answers 403 — and the webapp read that 403 as "not ready yet" forever:
 * `fetchLodyPlatformSnapshot` returns `null` on any non-ok response, so the
 * surface's poller never settled, the gated branch never mounted, no notice
 * rendered, and a 403 landed in the console every 500 ms. The member saw a rail
 * with an empty session zone and no explanation.
 *
 * The cutoff cannot be the answer here, because the fact is not about WHEN the
 * VM was created — a workspace's machine can be recreated onto a new image at
 * any moment, and the control plane learns nothing about it. So the browser
 * asks the box, once, before it commits to the session plane.
 *
 * THREE READINGS, and the distinction between the last two is the whole point:
 *
 * - `present` — the door answered. The surface mounts and its own poller takes
 *   over; a cold daemon is its problem, not this one's.
 * - `absent`  — 403 or 404. STRUCTURAL: this image has no session daemon and
 *   never will until the machine is replaced. One probe, no retry, and the
 *   workspace falls back to the full flag-off experience.
 * - `retry`   — anything else, including a network error. TRANSIENT: a booting
 *   box, a tunnel blip, a 503 from a bridge whose daemon has not written its
 *   catalog yet. Bounded retries, and then `present`, because the optimistic
 *   answer is the safe one: mounting the surface against a slow box costs a
 *   spinner, and stranding a good box on the legacy rail costs the feature.
 */
import { useEffect, useState } from "react";
import { LODY_SESSIONS_ENABLED } from "./flag.js";

/** What the browser believes about one box's session plane. */
export type LodySessionsCapability = "probing" | "present" | "absent";

/** One probe's reading. `retry` is not a state a surface may act on. */
export type LodyDoorReading = "present" | "absent" | "retry";

/**
 * A pre-Lody box answers 403 (dufs, reached by fall-through) or 404 (a gateway
 * that routes but has no bridge). Both mean the same thing and neither is worth
 * asking twice.
 *
 * A 403 from a NEW image is also possible — the gateway refuses `/lody/*` to a
 * viewer who holds no share — and the fallback is the right answer there too:
 * that member has no session plane on that box either.
 */
function isStructuralAbsence(status: number): boolean {
  return status === 403 || status === 404;
}

export function readLodyDoorStatus(status: number): LodyDoorReading {
  if (status >= 200 && status < 300) return "present";
  if (isStructuralAbsence(status)) return "absent";
  return "retry";
}

export interface LodyDoorProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Reads `/lody/platform` once, for its STATUS and nothing else.
 *
 * Deliberately not `fetchLodyPlatformSnapshot`: that parser folds every non-ok
 * status into `null`, which is exactly the collapse this module exists to undo.
 * The body is not read at all — a 403 body is dufs's HTML, and sniffing it for
 * a reason would be a parser for a page nobody owns.
 */
export async function probeLodySessionsDoor(
  platformUrl: string,
  options?: LodyDoorProbeOptions,
): Promise<LodyDoorReading> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const request: RequestInit = { method: "GET", credentials: "include" };
  if (options?.signal !== undefined) request.signal = options.signal;
  try {
    const response = await fetchImpl(platformUrl, request);
    return readLodyDoorStatus(response.status);
  } catch {
    // A network error is not an answer about the image. It is the tunnel, or a
    // box that is still coming up, and both resolve on their own.
    return "retry";
  }
}

/**
 * The delay before each retry, and therefore the budget: five attempts across
 * 7.5 s. Long enough to ride out a tunnel blip, short enough that a member does
 * not watch an empty rail; and the answer at the end of it is `present`, so the
 * length only decides how long the rail waits, never what it concludes.
 */
const PROBE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

/**
 * The probe, as the shell holds it: one answer per box, for as long as that box
 * is the active workspace's.
 *
 * `platformUrl` is `null` while the workspace has no running box, and that is
 * also what makes a machine RECREATE visible without a reload — the answer is
 * scoped to the effect that read it, so a machine that stops and comes back on
 * a new image is asked again. A module-level memo keyed by workspace would
 * have to be invalidated by hand at exactly that moment, and would go stale
 * precisely when a member acted on the notice this hook renders.
 */
export function useLodySessionsCapability(
  platformUrl: string | null,
  fetchImpl?: typeof fetch,
): LodySessionsCapability {
  const [capability, setCapability] = useState<LodySessionsCapability>("probing");

  useEffect(() => {
    setCapability("probing");
    if (!LODY_SESSIONS_ENABLED || platformUrl === null) return undefined;
    let cancelled = false;
    let timer = 0;
    const controller = new AbortController();
    const options: LodyDoorProbeOptions = { signal: controller.signal };
    if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;

    const attempt = async (index: number): Promise<void> => {
      const reading = await probeLodySessionsDoor(platformUrl, options);
      if (cancelled) return;
      if (reading === "absent") {
        // The one line this path is allowed to write. Not an error: a box on an
        // older image is a fact about the fleet, and the rail says so in words
        // a member can act on.
        console.info("lody: this box serves no session daemon; using the legacy rail", {
          platformUrl,
        });
        setCapability("absent");
        return;
      }
      const delay = PROBE_RETRY_DELAYS_MS[index];
      if (reading === "present" || delay === undefined) {
        setCapability("present");
        return;
      }
      timer = window.setTimeout(() => void attempt(index + 1), delay);
    };
    void attempt(0);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [platformUrl, fetchImpl]);

  return capability;
}
