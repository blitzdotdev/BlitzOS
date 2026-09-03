import type {
  ElectronPublicBrowserBounds,
  ElectronPublicBrowserState,
  IpcPushMap,
  IpcSendMap,
  SendLocalSessionControlResult,
} from '@lody/shared/electron-ipc';
import type { LocalSessionControlRequest, LocalSessionControlResponse } from '@lody/shared';
import { LocalSessionControlResponseSchema } from '@lody/shared/message-schemas';
// This deliberately crosses from the shared renderer package into the Electron app at
// type level only. The import is erased from every browser bundle; see both packages'
// AGENTS.md files before changing it into a runtime dependency or duplicating the API.
import type { ElectronIpcServices } from '../../../../apps/electron/src/main/ipc/register-services';

export type IpcServices = ElectronIpcServices;

export type LodyIpcInvokeBridge = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

export type LodyIpcBridge = LodyIpcInvokeBridge & {
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
  send: (channel: string, payload?: unknown) => void;
};

/**
 * One renderer subtree's IPC authority. A bound client captures one bridge;
 * the default window client deliberately resolves the bridge again per call.
 */
export type LodyIpcClient = {
  readonly signal: AbortSignal;
  getServices: () => IpcServices | null;
  on: <K extends keyof IpcPushMap>(
    channel: K,
    handler: (payload: IpcPushMap[K]) => void
  ) => () => void;
  send: <K extends keyof IpcSendMap>(channel: K, payload: IpcSendMap[K]) => void;
  dispose: () => void;
};

export function createLodyIpcProxy<T extends Record<string, object> = IpcServices>(
  ipc: LodyIpcInvokeBridge | null | undefined
): T | null {
  if (!ipc) return null;
  const cache = new Map<string, object>();
  return new Proxy({} as T, {
    get(_target, groupName: string) {
      let group = cache.get(groupName);
      if (!group) {
        group = new Proxy(
          {},
          {
            get(_g, methodName: string) {
              return (...args: unknown[]) => ipc.invoke(`${groupName}.${methodName}`, ...args);
            },
          }
        );
        cache.set(groupName, group);
      }
      return group;
    },
  });
}

function readIpcBridge(): LodyIpcBridge | null {
  if (typeof window === 'undefined') return null;
  return window.ipc ?? null;
}

function createIpcClient(readBridge: () => LodyIpcBridge | null): LodyIpcClient {
  return {
    signal: new AbortController().signal,
    getServices: () => createLodyIpcProxy<IpcServices>(readBridge()),
    on: (channel, handler) => {
      const bridge = readBridge();
      if (!bridge) return () => {};
      // SAFETY: `LodyIpcBridge` is the preload contract. Its channel selects
      // the matching `IpcPushMap` payload; the structural bridge type keeps the
      // implementation host-neutral and this generic client restores that map.
      return bridge.on(channel, (payload) => handler(payload as IpcPushMap[typeof channel]));
    },
    send: (channel, payload) => {
      readBridge()?.send(channel, payload);
    },
    dispose: () => {},
  };
}

/**
 * Electron-compatible default: it intentionally does not capture the current
 * bridge, because existing renderer callers have always observed window.ipc at
 * the moment of each operation.
 */
export const windowIpcClient: LodyIpcClient = createIpcClient(readIpcBridge);

/** Capture one bridge for a surface/runtime lifetime. */
export function createBoundIpcClient(bridge: LodyIpcBridge): LodyIpcClient {
  const controller = new AbortController();
  const subscriptions = new Set<() => void>();
  const guardedBridge: LodyIpcBridge = {
    ...bridge,
    invoke: (channel, ...args) =>
      controller.signal.aborted
        ? Promise.reject(new Error('IPC client is disposed'))
        : bridge.invoke(channel, ...args),
  };
  const client = createIpcClient(() => (controller.signal.aborted ? null : guardedBridge));
  return {
    ...client,
    signal: controller.signal,
    on: (channel, handler) => {
      const unsubscribe = client.on(channel, handler);
      subscriptions.add(unsubscribe);
      return () => { if (subscriptions.delete(unsubscribe)) unsubscribe(); };
    },
    dispose: () => { controller.abort(); subscriptions.forEach((unsubscribe) => unsubscribe()); subscriptions.clear(); },
  };
}

export function getIpcServices(client: LodyIpcClient = windowIpcClient): IpcServices | null {
  return client.getServices();
}

export function onIpcEvent<K extends keyof IpcPushMap>(
  channel: K,
  handler: (payload: IpcPushMap[K]) => void,
  client: LodyIpcClient = windowIpcClient
): () => void {
  return client.on(channel, handler);
}

export function sendIpc<K extends keyof IpcSendMap>(
  channel: K,
  payload: IpcSendMap[K],
  client: LodyIpcClient = windowIpcClient
): void {
  client.send(channel, payload);
}

export async function sendLocalSessionControl(
  message: LocalSessionControlRequest,
  onResponse?: (response: LocalSessionControlResponse) => void,
  client: LodyIpcClient = windowIpcClient
): Promise<SendLocalSessionControlResult> {
  const services = getIpcServices(client);
  if (!services) return { ok: false, error: 'ipc_unavailable' };
  const requestId = crypto.randomUUID();
  const stop = onIpcEvent(
    'sessionControl.response',
    (event) => {
      if (event.requestId !== requestId) return;
      const parsed = LocalSessionControlResponseSchema.safeParse(event.response, { jitless: true });
      if (parsed.success) onResponse?.(parsed.data as LocalSessionControlResponse);
    },
    client
  );
  try {
    return await services.sessionControl.send({ requestId, message });
  } finally {
    stop();
  }
}

export function getPublicBrowserBridge(client: LodyIpcClient = windowIpcClient) {
  const services = getIpcServices(client);
  if (!services) return null;
  const pub = services.publicBrowser;
  return {
    capability: 'web-contents-view-v1' as const,
    create: (browserId: string, bounds: ElectronPublicBrowserBounds) =>
      pub.create({ browserId, bounds }),
    navigate: (browserId: string, url: string) => pub.navigate({ browserId, url }),
    back: (browserId: string) => pub.back({ browserId }),
    forward: (browserId: string) => pub.forward({ browserId }),
    reload: (browserId: string) => pub.reload({ browserId }),
    stop: (browserId: string) => pub.stop({ browserId }),
    setBounds: (browserId: string, bounds: ElectronPublicBrowserBounds) =>
      pub.setBounds({ browserId, bounds }),
    setVisible: (browserId: string, visible: boolean) => pub.setVisible({ browserId, visible }),
    destroy: (browserId: string) => pub.destroy({ browserId }),
    onState: (handler: (state: ElectronPublicBrowserState) => void) =>
      onIpcEvent('publicBrowser.state', handler, client),
  };
}
