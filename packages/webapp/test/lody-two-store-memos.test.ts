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

function replaceWithStructurallyEqualInputs(
  seeded: ReturnType<typeof seedStore>,
  now: number,
): void {
  seeded.store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(seeded.ids.sessionId)]: { ...seeded.session },
  });
  seeded.store.set(machineMetaCacheAtom, {
    [getMachineRoomId(seeded.ids.machineId)]: {
      ...seeded.machine,
      sessions: [...seeded.machine.sessions],
    },
  });
  seeded.store.set(lodyPresenceStatesAtom, {
    [`machine:${seeded.ids.machineId}:${seeded.ids.instanceId}`]: {
      kind: "machine",
      machineId: seeded.ids.machineId,
      instanceId: seeded.ids.instanceId,
      updatedAt: now,
    },
  });
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

  it("recomputes equal interleaved replacements without borrowing unequal values", () => {
    const now = Date.now();
    const a = seedStore("A", now);
    const b = seedStore("A", now);

    const sessionsA = readSessionList(a.store);
    const machinesA = readMachineMap(a.store);
    const onlineA = readOnlineMachines(a.store);
    const sessionMetaA = readSessionMeta(a.store, getSessionRoomId(a.ids.sessionId));
    replaceWithStructurallyEqualInputs(b, now);
    const sessionsB = readSessionList(b.store);
    const machinesB = readMachineMap(b.store);
    const onlineB = readOnlineMachines(b.store);
    const sessionMetaB = readSessionMeta(b.store, getSessionRoomId(b.ids.sessionId));

    // Cross-store reference reuse is permitted here because all visible values
    // are structurally equal; these identities prove the shared memo branches ran.
    expect(sessionsB).toBe(sessionsA);
    expect(machinesB).toBe(machinesA);
    expect(onlineB).toBe(onlineA);
    expect(sessionMetaB).toBe(sessionMetaA);

    b.store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(b.ids.sessionId)]: { ...b.session, title: "Changed only in B" },
    });
    b.store.set(machineMetaCacheAtom, {
      [getMachineRoomId(b.ids.machineId)]: { ...b.machine, name: "Changed machine B" },
    });
    b.store.set(lodyPresenceStatesAtom, {});
    expect(readSessionList(b.store)[0]?.title).toBe("Changed only in B");
    expect(readMachineMap(b.store).get(b.ids.machineId)?.name).toBe("Changed machine B");
    expect([...readOnlineMachines(b.store)]).toEqual([]);

    // Invalidating A after B changed the module globals must still return A's
    // own equal replacement, never B's most recent unequal projection.
    replaceWithStructurallyEqualInputs(a, now);
    expect(readSessionList(a.store)[0]?.title).toBe(a.session.title);
    expect(readMachineMap(a.store).get(a.ids.machineId)?.name).toBe(a.machine.name);
    expect([...readOnlineMachines(a.store)]).toEqual([a.ids.machineId]);
    expect(readSessionMeta(a.store, getSessionRoomId(a.ids.sessionId))?.title)
      .toBe(a.session.title);
  });
});
