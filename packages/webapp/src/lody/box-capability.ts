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
 *
 * A SECOND STRUCTURAL ABSENCE, AND IT IS NOT ABOUT THE IMAGE (wave 4, C4).
 *
 * An org member who holds no machine in a workspace reaches no box at all: the
 * control plane refuses every `/workspaces/:id/webapp/7445/*` call with 409 and
 * the sentence `machineForRequest` writes (`core/workspaces.ts`). 409 is not one
 * of the two statuses above, so it read as TRANSIENT — five probes, then the
 * optimistic `present`, then a surface whose platform poller can never settle
 * because there is nothing behind the address. The member watched "connecting"
 * for as long as they were willing to.
 *
 * The fix is not "409 is absent". Two of the three 409s that route can produce
 * ARE transient — a machine that is stopped, and a workspace whose VM id has not
 * landed yet — and folding them in would strand a member on the legacy rail for
 * the ten seconds their box takes to start. So this reading, alone among them,
 * looks at the BODY: the control plane's error envelope is ours
 * (`core/app.ts`: `{ error, retryAction }`), and one of its three sentences means
 * "there is no machine here and polling will not make one".
 *
 * IT IS A FOURTH CAPABILITY AND NOT A FIELD BESIDE THE THIRD. A box on an old
 * image and a member with no machine both mean "no session plane for you here",
 * and the rail, the chunk gate and the fresh-workspace default behave
 * identically for both; only the notice's words differ. So the value carries the
 * distinction and `lodySessionsUnavailable` carries the sameness — a caller that
 * kept comparing against `"absent"` would have been silently wrong, which is
 * why there is no such comparison left.
 */
import { useEffect, useState } from "react";
import { isJsonObject, isJsonString, parseJson } from "@blitzos/schema";
import {
  boxGatewayFetch,
  boxGatewayHealth,
  boxGatewayPollIntervalMs,
  resetBoxGatewayHealth,
} from "../box-gateway-health.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";

/**
 * What the browser believes about one box's session plane.
 *
 * `absent` and `noMachine` read the SAME to a surface — it does not mount, the
 * chunk is not fetched and the rail goes back to its flag-off shape for either.
 * Read them through `lodySessionsUnavailable` rather than by comparing against
 * `"absent"`, which was the whole set before wave 4 and is now half of it.
 *
 * THEY DIFFER IN WHETHER THE QUESTION IS CLOSED, and only the prober cares.
 * `absent` is structural: a box image without a session daemon does not grow
 * one. `noMachine` is a PHASE — on a workspace the member just created their
 * machine is arriving as they watch — so the prober keeps asking and the
 * surface converges on its own. See `useLodySessionsCapability`.
 */
export type LodySessionsCapability = "probing" | "present" | "absent" | "noMachine" | "stalled";

/** One probe's reading. `retry` is not a state a surface may act on. */
export type LodyDoorReading = "present" | "absent" | "noMachine" | "retry";

/**
 * This member has no session plane on this box, whatever the reason.
 *
 * The rail, the chunk gate and the fresh-workspace default all ask this and
 * nothing finer: they behave identically for an old image and for a member with
 * no machine. Only `SessionRail`'s notice tells the two apart, because only the
 * notice has anything different to say.
 */
export function lodySessionsUnavailable(capability: LodySessionsCapability): boolean {
  return capability === "absent" || capability === "noMachine" || capability === "stalled";
}

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

/**
 * The control plane's refusal for a caller who holds no machine here
 * (`machineForRequest`, `packages/control-plane/core/workspaces.ts`). Matched as
 * a PREFIX of `{ error }` so the advice half of that sentence can be reworded
 * without breaking the reading; `lody-old-box-fallback.test.tsx` reads the
 * control-plane source and fails if this string leaves it.
 */
export const NO_MACHINE_REFUSAL = "you have no machine in this workspace";

/**
 * The one 409 that is a fact rather than a phase.
 *
 * The other two that route produces — "your machine in this workspace is not
 * running" and "workspace is not ready for webapp access" — are a box between
 * states, and they resolve without anybody doing anything. This one resolves
 * only when an admin provisions a machine, which is not something a poller can
 * wait for.
 *
 * The body is the control plane's own envelope and nobody else's: the proxy
 * refuses before it reaches the box, so a 409 here can only have been written by
 * `core/app.ts`. A body that does not parse is read as transient, which is the
 * safe direction — it costs four more probes, not a wrong verdict.
 */
export function readNoMachineRefusal(body: string): boolean {
  const decoded = parseJson(body);
  if (!isJsonObject(decoded)) return false;
  const message = decoded.error;
  return message !== undefined && isJsonString(message) && message.startsWith(NO_MACHINE_REFUSAL);
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
 * Reads `/lody/platform` once, for its STATUS — and, on a 409 alone, its body.
 *
 * Deliberately not `fetchLodyPlatformSnapshot`: that parser folds every non-ok
 * status into `null`, which is exactly the collapse this module exists to undo.
 *
 * THE BODY IS READ FOR ONE STATUS AND NO OTHER. A 403 body is dufs's HTML and a
 * 503's belongs to the bridge; sniffing either would be a parser for a page
 * nobody owns. A 409 on this path can only come from the control plane's proxy,
 * whose envelope is ours, and it is the one status whose meaning the number does
 * not carry.
 */
export async function probeLodySessionsDoor(
  platformUrl: string,
  options?: LodyDoorProbeOptions,
): Promise<LodyDoorReading> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    // Through `boxGatewayFetch` for the DEADLINE first (BUG-CV-01): this probe
    // used to hand the browser a request that could hang for the life of the
    // tab. Its verdict reaching the shell's reachability signal (BUG-CV-02) is
    // the second thing the helper does, and the reason no new poll was added
    // for it — five probes against a dead tunnel are already five answers.
    const response = await boxGatewayFetch(platformUrl, fetchImpl, options?.signal);
    if (response.status === 409) {
      return readNoMachineRefusal(await response.text()) ? "noMachine" : "retry";
    }
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
 * How long an OPTIMISTIC `present` may go unanswered before it is called what
 * it is (the blank blitzos workspace, 2026-09-03).
 *
 * The retry budget above ends on `present` without the door ever having
 * answered, and that was the whole of the shell's opinion: the surface mounted
 * and polled `/lody/platform` every half second, drawing nothing until the
 * daemon wrote its catalog — no rail, no "New session", no tabs, because the
 * surface owns all three. On a box whose daemon never provisions, that is a
 * running workspace that shows a member nothing at all, for as long as the tab
 * is open, with no way to open even a terminal.
 *
 * Forty-five seconds is longer than any daemon this shell has measured takes
 * to write its catalog on a warm box, and short enough that a member is not
 * left staring. After it the reading is `stalled`: the shell takes the rail and
 * the panes back — terminals work, the notice says what is wrong — and keeps
 * asking, so a daemon that was merely slow brings the surface back on its own.
 */
const DOOR_STALL_MS = 45_000;

/** How often to ask again after the budget ran out without an answer, both
 * before the stall is called and after. */
const DOOR_REPROBE_INTERVAL_MS = 5_000;

/**
 * How often to ask again while the member holds no machine here.
 *
 * Five seconds against a reachable edge, because the case this exists for is a
 * workspace the member just created and is watching provision — a machine
 * arrives in about forty. It is not a retry budget: the question stays open for
 * as long as the answer holds, so this only decides how quickly the surface
 * converges once the machine lands. `boxGatewayPollIntervalMs` stretches it to
 * 30 s the moment the box stops being reachable, so a workspace nobody will
 * provision costs two requests a minute rather than twelve.
 */
const NO_MACHINE_REPROBE_INTERVAL_MS = 5_000;

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
    // A new box is a new question about reachability too. This effect keys on
    // exactly the change that invalidates the old answer — a different
    // workspace, or a machine that stopped and came back — so the reset lives
    // here rather than in a second effect that would have to guess the moment.
    resetBoxGatewayHealth();
    if (!LODY_SESSIONS_ENABLED || platformUrl === null) return undefined;
    let cancelled = false;
    let timer = 0;
    const controller = new AbortController();
    const options: LodyDoorProbeOptions = { signal: controller.signal };
    if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;

    // Said once per verdict, not once per probe: `noMachine` keeps asking now,
    // and a line per poll for the life of the tab is noise, not a record.
    let announced: LodySessionsCapability | null = null;
    const announce = (reading: "absent" | "noMachine" | "stalled"): void => {
      if (announced === reading) return;
      announced = reading;
      // Not an error: an older image and a member without a machine are both
      // facts about the fleet, and the rail says which in words a member can
      // act on.
      console.info(
        reading === "absent"
          ? "lody: this box serves no session daemon; using the legacy rail"
          : reading === "noMachine"
            ? "lody: you hold no machine in this workspace; using the legacy rail"
            : "lody: the session daemon on this box has not answered; using the legacy rail",
        { platformUrl },
      );
    };

    // THE OPTIMISTIC `present` IS PROVISIONAL. Once the budget runs out without
    // an answer, the door is asked every few seconds until it really answers:
    // a 2xx settles `present` for good; a structural absence and the machineless
    // 409 are read exactly as they are on the first attempt; and once
    // `DOOR_STALL_MS` has passed without any of those, the reading is `stalled`
    // — which keeps asking too, so a slow daemon recovers without a reload.
    const watch = async (optimisticAt: number): Promise<void> => {
      const reading = await probeLodySessionsDoor(platformUrl, options);
      if (cancelled) return;
      if (reading === "present") {
        setCapability("present");
        return;
      }
      if (reading === "absent") {
        announce("absent");
        setCapability("absent");
        return;
      }
      if (reading === "noMachine") {
        announce("noMachine");
        setCapability("noMachine");
        timer = window.setTimeout(
          () => void attempt(PROBE_RETRY_DELAYS_MS.length),
          boxGatewayPollIntervalMs(boxGatewayHealth(), NO_MACHINE_REPROBE_INTERVAL_MS),
        );
        return;
      }
      if (Date.now() - optimisticAt >= DOOR_STALL_MS) {
        announce("stalled");
        setCapability("stalled");
      }
      timer = window.setTimeout(
        () => void watch(optimisticAt),
        boxGatewayPollIntervalMs(boxGatewayHealth(), DOOR_REPROBE_INTERVAL_MS),
      );
    };

    const attempt = async (index: number): Promise<void> => {
      const reading = await probeLodySessionsDoor(platformUrl, options);
      if (cancelled) return;
      // STRUCTURAL, AND IT STAYS STRUCTURAL. A box image without a session
      // daemon does not grow one while the tab is open; the effect re-keys on
      // `platformUrl` when the machine is replaced, which is the only event
      // that can change this answer.
      if (reading === "absent") {
        announce("absent");
        setCapability("absent");
        return;
      }
      // NOT STRUCTURAL, WHICH IS THE FIX. This reading used to settle beside
      // `absent`, on the reasoning that it "resolves only when an admin
      // provisions a machine, which is not something a poller can wait for".
      // That is true of somebody else's workspace and false of the one the
      // member just created: their own machine is being provisioned as they
      // watch, it arrives in seconds, and the settled verdict outlived it — so
      // the rail kept its flag-off shape until the member switched workspaces
      // and came back. The notice still renders immediately, because the
      // capability is set either way; what changes is that the question stays
      // open. Cost is one request per 30 s while the answer holds, which is
      // what `boxGatewayPollIntervalMs` already spends on a cold box.
      if (reading === "noMachine") {
        announce("noMachine");
        setCapability("noMachine");
        timer = window.setTimeout(
          () => void attempt(index),
          boxGatewayPollIntervalMs(boxGatewayHealth(), NO_MACHINE_REPROBE_INTERVAL_MS),
        );
        return;
      }
      if (reading === "present") {
        setCapability("present");
        return;
      }
      const delay = PROBE_RETRY_DELAYS_MS[index];
      if (delay === undefined) {
        // The budget is spent and the door has not answered: optimistic
        // `present`, and the watchdog above decides whether it stays so.
        setCapability("present");
        timer = window.setTimeout(
          () => void watch(Date.now()),
          boxGatewayPollIntervalMs(boxGatewayHealth(), DOOR_REPROBE_INTERVAL_MS),
        );
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
