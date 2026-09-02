import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  getMachineRoomId,
  getSessionRoomId,
} from "@lody/shared";
import {
  sessionListAtom,
  sessionMetaAtomFamily,
  sessionMetaCacheAtom,
  machineMetaCacheAtom,
} from "@lody/components/atoms/doc-meta";
import {
  getMachineMetaByIdAtomFamily,
  getMachineMetaMapAtom,
} from "@lody/components/atoms/machines";
import {
  lodyPresenceNowMsAtom,
  lodyPresenceStatesAtom,
  machineOnlineStatusAtomFamily,
  onlineMachineIdsAtom,
} from "@lody/components/atoms/presence";

function daemonIds(tag: string) {
  const sessionId = `session-${tag}`;
  const machineId = `machine-${tag}`;
  const instanceId = `instance-${tag}`;
  return { sessionId, machineId, instanceId };
}

function seedStore(tag: string, now: number) {
  const store = createStore();
  const ids = daemonIds(tag);
  const session = {
    id: ids.sessionId,
    machineId: ids.machineId,
    createdAt: `2026-09-02T00:00:0${tag === "A" ? "1" : "2"}.000Z`,
    title: `Session ${tag}`,
    userId: `local:${tag}`,
    cliType: "builtin",
    agentType: "claude",
  };
  const machine = {
    id: ids.machineId,
    name: `Machine ${tag}`,
    ownerUserId: `local:${tag}`,
    cliVersion: `0.${tag === "A" ? "1" : "2"}.0`,
    os: "linux",
    sessions: [ids.sessionId],
  };
  const presenceKey = `machine:${ids.machineId}:${ids.instanceId}`;
  const presence = {
    [presenceKey]: {
      kind: "machine",
      machineId: ids.machineId,
      instanceId: ids.instanceId,
      updatedAt: now,
    },
  };

  store.set(sessionMetaCacheAtom, { [getSessionRoomId(ids.sessionId)]: session });
  store.set(machineMetaCacheAtom, { [getMachineRoomId(ids.machineId)]: machine });
  store.set(lodyPresenceStatesAtom, presence);
  store.set(lodyPresenceNowMsAtom, now);
  return { store, ids, session, machine };
}

type SessionListValue = Array<{ id: string; title?: string }>;
type MachineMapValue = Map<string, { name: string }>;

function readSessionList(store: ReturnType<typeof createStore>): SessionListValue {
  // SAFETY: sessionListAtom derives an array of normalized SessionMeta entries.
  return store.get(sessionListAtom) as SessionListValue;
}

function readSessionMeta(store: ReturnType<typeof createStore>, roomId: string) {
  // SAFETY: this atom family reads the SessionMeta fixture stored under roomId.
  return store.get(sessionMetaAtomFamily(roomId)) as { title?: string } | undefined;
}

function readMachineMap(store: ReturnType<typeof createStore>): MachineMapValue {
  // SAFETY: getMachineMetaMapAtom derives a Map keyed by daemon machine id.
  return store.get(getMachineMetaMapAtom) as MachineMapValue;
}

function readMachineMeta(store: ReturnType<typeof createStore>, machineId: string) {
  // SAFETY: this atom family normalizes the MachineMeta fixture for machineId.
  return store.get(getMachineMetaByIdAtomFamily(machineId)) as { name: string } | null;
}

function readOnlineMachines(store: ReturnType<typeof createStore>): ReadonlySet<string> {
  // SAFETY: onlineMachineIdsAtom always derives a readonly set of machine ids.
  return store.get(onlineMachineIdsAtom) as ReadonlySet<string>;
}

describe("module memoization across independent Lody stores", () => {
  it("returns each store's values for doc meta, machines and presence", () => {
    const now = Date.now();
    const a = seedStore("A", now);
    const b = seedStore("B", now);

    // Interleave every read so each module-level previous-value memo observes
    // the other store between two reads of the first.
    expect(readSessionList(a.store).map((session) => session.id)).toEqual([a.ids.sessionId]);
    expect(readSessionList(b.store).map((session) => session.id)).toEqual([b.ids.sessionId]);
    expect(readSessionMeta(a.store, getSessionRoomId(a.ids.sessionId))?.title).toBe(
      a.session.title,
    );
    expect(readSessionMeta(b.store, getSessionRoomId(b.ids.sessionId))?.title).toBe(
      b.session.title,
    );

    expect([...readMachineMap(a.store).keys()]).toEqual([a.ids.machineId]);
    expect([...readMachineMap(b.store).keys()]).toEqual([b.ids.machineId]);
    expect(readMachineMeta(a.store, a.ids.machineId)?.name).toBe(a.machine.name);
    expect(readMachineMeta(b.store, b.ids.machineId)?.name).toBe(b.machine.name);

    expect([...readOnlineMachines(a.store)]).toEqual([a.ids.machineId]);
    expect([...readOnlineMachines(b.store)]).toEqual([b.ids.machineId]);
    expect(a.store.get(machineOnlineStatusAtomFamily(a.ids.machineId))).toBe("online");
    expect(b.store.get(machineOnlineStatusAtomFamily(b.ids.machineId))).toBe("online");

    expect(readSessionList(a.store)[0]?.id).toBe(a.ids.sessionId);
    expect(readMachineMap(a.store).get(a.ids.machineId)?.name).toBe(a.machine.name);
    expect(readOnlineMachines(a.store).has(a.ids.machineId)).toBe(true);
  });
});
