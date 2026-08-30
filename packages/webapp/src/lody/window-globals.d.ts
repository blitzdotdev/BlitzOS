/**
 * The two window globals the Lody local bridge owns.
 *
 * `vendor/lody/packages/components/src/window-globals.d.ts` declares both, but
 * `vendor-modules.d.ts` deliberately keeps the vendor tree out of our
 * typecheck, so its ambient declarations never reach us. These are the BlitzOS
 * side of the same seam, and they are narrower on purpose: `ipc` is exactly the
 * three-method bridge `createLodyIpcProxy`
 * (`vendor/lody/packages/components/src/lib/electron-ipc-client.ts:22`)
 * dispatches through, with the payload unions this package actually produces
 * rather than upstream's `unknown`.
 *
 * `__LODY_ELECTRON__` is absent by design. Setting it would light up 44
 * unrelated Electron paths (window controls, the native theme bridge, the
 * updater, OneSignal); `__LODY_LOCAL_BRIDGE__` is what the five patched guards
 * in `vendor/lody/BLITZ-PATCHES.md` read instead.
 */
import type {
  LodyIpcArgument,
  LodyIpcPush,
  LodyIpcReply,
  LodyIpcSendPayload,
} from "./wire-types.js";

declare global {
  interface Window {
    ipc?: {
      invoke: (channel: string, ...args: LodyIpcArgument[]) => Promise<LodyIpcReply>;
      on: (channel: string, listener: (payload: LodyIpcPush) => void) => () => void;
      send: (channel: string, payload?: LodyIpcSendPayload) => void;
    };
    __LODY_LOCAL_BRIDGE__?: true;
  }
}

export {};
