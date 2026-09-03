/** Per-daemon runtime leases. A holder releases only after repo/IPC teardown. */
import type { LodySurfaceIdentity } from "./keepalive-pool.js";

interface IdentityWaiter {
  entryId: string;
  signal: AbortSignal;
  resolve: (granted: boolean) => void;
  onAbort: () => void;
}

interface IdentityClaimSlot {
  holder: string | null;
  waiters: IdentityWaiter[];
}

export interface LodySurfaceIdentityClaims {
  claim(identity: LodySurfaceIdentity, entryId: string, signal: AbortSignal): Promise<boolean>;
  release(entryId: string): void;
}

function identityKey(identity: LodySurfaceIdentity): string {
  return JSON.stringify([identity.machineId, identity.lwWorkspaceId]);
}

export function createLodySurfaceIdentityClaims(): LodySurfaceIdentityClaims {
  const slots = new Map<string, IdentityClaimSlot>();

  const grantNext = (key: string, slot: IdentityClaimSlot): void => {
    while (slot.waiters.length > 0) {
      const waiter = slot.waiters.shift();
      if (waiter === undefined) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      slot.holder = waiter.entryId;
      waiter.resolve(true);
      return;
    }
    slots.delete(key);
  };

  return {
    claim: async (identity, entryId, signal) => {
      if (signal.aborted) return false;
      const key = identityKey(identity);
      const slot = slots.get(key) ?? { holder: null, waiters: [] };
      slots.set(key, slot);
      if (slot.holder === entryId) return true;
      if (slot.holder === null) {
        slot.holder = entryId;
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        const waiter: IdentityWaiter = {
          entryId,
          signal,
          resolve,
          onAbort: () => {
            slot.waiters = slot.waiters.filter((item) => item !== waiter);
            signal.removeEventListener("abort", waiter.onAbort);
            resolve(false);
          },
        };
        slot.waiters.push(waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      });
    },
    release: (entryId) => {
      for (const [key, slot] of slots) {
        if (slot.holder === entryId) {
          slot.holder = null;
          grantNext(key, slot);
        } else {
          const cancelled = slot.waiters.filter((waiter) => waiter.entryId === entryId);
          slot.waiters = slot.waiters.filter((waiter) => waiter.entryId !== entryId);
          for (const waiter of cancelled) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
            waiter.resolve(false);
          }
          if (slot.holder === null && slot.waiters.length === 0) slots.delete(key);
        }
      }
    },
  };
}
