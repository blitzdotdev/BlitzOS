/** React adapter for the pure identity-keyed surface pool. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type {
  LodyRailBinding,
  LodySessionSurfaceApi,
  LodySessionSurfaceHostProps,
  LodySessionSurfacePoolHostProps,
} from "./SessionSurface.js";
import {
  activateLodySurface,
  createLodyKeepalivePool,
  deactivateLodySurface,
  discontinueLodySurface,
  LODY_KEEPALIVE_STORAGE_KEY,
  lodyKeepaliveEnabled,
  lodySurfacePoolCapacity,
  subscribeLodyKeepalivePolicy,
  reportLodySurfaceIdentity,
  requestLodySurface,
  resizeLodyKeepalivePool,
  type LodyKeepalivePool,
  type LodySurfaceIdentity,
  type LodySurfaceKind,
} from "./keepalive-pool.js";
import { MOBILE_WEBAPP_QUERY } from "../mobile-webapp.js";
import type { BlitzViewer } from "./platform.js";
import type { LodyRuntimeEndpoints } from "./runtime.js";
import type { SurfaceTabsBinding } from "./surface-tabs.js";
import { markLodyActivationPhase } from "./surface-activation-performance.js";
import { createLodySurfaceIdentityClaims } from "./surface-identity-claims.js";

export interface LodySurfacePoolTarget {
  kind: LodySurfaceKind;
  endpoints: LodyRuntimeEndpoints;
  workspaceTitle: string;
  readOnly: boolean;
  shared?: { sessionId: string };
  initialSessionId?: string;
  desiredSessionId: string | null;
  desiredArchive: boolean;
}

interface SurfaceDefinition {
  entryId: string;
  mountKey: string;
  target: LodySurfacePoolTarget;
}

interface PoolRenderState {
  pool: LodyKeepalivePool;
  definitions: readonly SurfaceDefinition[];
  targetToken: string | null;
}

interface SurfaceCallbacks {
  onIdentityClaim: (identity: LodySurfaceIdentity, signal: AbortSignal) => Promise<boolean>;
  onIdentity: (identity: LodySurfaceIdentity) => void;
  onSurfaceReleased: () => void;
  onContinuityLost: () => void;
  onApiReady: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange: (sessionId: string | null) => void;
}

export interface LodySurfacePoolProps {
  Surface: ComponentType<LodySessionSurfacePoolHostProps>;
  target: LodySurfacePoolTarget | null;
  viewer: BlitzViewer;
  visible: boolean;
  railHost: HTMLElement | null;
  rail: LodyRailBinding;
  surfaceTabs?: SurfaceTabsBinding;
  onApiReady?: (api: LodySessionSurfaceApi | null) => void;
  onActiveSessionChange?: (sessionId: string | null) => void;
}

/** Every URL is only a hint for finding a known identity; it is never a key. */
export function lodyEndpointFingerprint(endpoints: LodyRuntimeEndpoints): string {
  return JSON.stringify([
    endpoints.syncUrl,
    endpoints.rpcUrl,
    endpoints.controlUrl,
    endpoints.projectUrl,
    endpoints.platformUrl,
    endpoints.filesBase,
    endpoints.filesRoot ?? null,
  ]);
}

const endpointFunctionIds = new WeakMap<Function, number>();
let nextEndpointFunctionId = 1;

function endpointFunctionToken(value: Function | undefined): number | null {
  if (value === undefined) return null;
  const existing = endpointFunctionIds.get(value);
  if (existing !== undefined) return existing;
  const created = nextEndpointFunctionId;
  nextEndpointFunctionId += 1;
  endpointFunctionIds.set(value, created);
  return created;
}

function tokenFor(target: LodySurfacePoolTarget): string {
  return JSON.stringify([
    target.kind,
    lodyEndpointFingerprint(target.endpoints),
    endpointFunctionToken(target.endpoints.fetchImpl),
    endpointFunctionToken(target.endpoints.webSocketConstructor),
    target.workspaceTitle,
    target.readOnly,
    target.shared?.sessionId ?? null,
  ]);
}

function retainDefinitions(
  definitions: readonly SurfaceDefinition[],
  pool: LodyKeepalivePool,
): SurfaceDefinition[] {
  const live = new Set(pool.entries.map((entry) => entry.entryId));
  return definitions.filter((definition) => live.has(definition.entryId));
}

function transitionToTarget(
  state: PoolRenderState,
  target: LodySurfacePoolTarget,
  token: string,
  capacity: number,
): PoolRenderState {
  const resized = resizeLodyKeepalivePool(state.pool, capacity);
  const resizedState = {
    ...state,
    pool: resized.pool,
    definitions: retainDefinitions(state.definitions, resized.pool),
  };
  const requested = requestLodySurface(resizedState.pool, {
    endpointFingerprint: lodyEndpointFingerprint(target.endpoints),
    kind: target.kind,
  });
  if (requested.entryId === null) return resizedState;
  const activated = activateLodySurface(requested.pool, requested.entryId);
  let definitions = retainDefinitions(resizedState.definitions, activated.pool);
  const existing = definitions.findIndex((item) => item.entryId === requested.entryId);
  if (existing === -1) {
    definitions = [...definitions, {
      entryId: requested.entryId,
      mountKey: `${requested.entryId}:${token}`,
      target,
    }];
  } else {
    definitions = definitions.map((item) =>
      item.entryId === requested.entryId && item.mountKey !== `${requested.entryId}:${token}`
        ? { ...item, mountKey: `${requested.entryId}:${token}`, target }
        : item);
  }
  return { pool: activated.pool, definitions, targetToken: token };
}

function currentPoolCapacity(): number {
  if (!lodyKeepaliveEnabled()) return 1;
  const browserNavigator: (Navigator & { readonly deviceMemory?: number }) | undefined =
    globalThis.navigator;
  const memory = browserNavigator?.deviceMemory;
  const deviceMemory = memory !== undefined && Number.isFinite(memory) && memory > 0
    ? memory
    : undefined;
  const desktopClass = window.matchMedia?.("(pointer: fine)").matches === true
    && window.matchMedia(MOBILE_WEBAPP_QUERY).matches === false;
  return lodySurfacePoolCapacity({ deviceMemory, desktopClass });
}

function transitionToNoTarget(state: PoolRenderState): PoolRenderState {
  const deactivated = deactivateLodySurface(state.pool);
  return {
    pool: deactivated.pool,
    definitions: retainDefinitions(state.definitions, deactivated.pool),
    targetToken: null,
  };
}

function routeMatches(api: LodySessionSurfaceApi, target: LodySurfacePoolTarget): boolean {
  if (target.desiredArchive) return api.isArchiveOpen();
  return !api.isArchiveOpen() && api.activeSessionId() === target.desiredSessionId;
}

function navigateToTarget(api: LodySessionSurfaceApi, target: LodySurfacePoolTarget): void {
  if (target.desiredArchive) {
    api.openArchive();
  } else if (target.desiredSessionId === null) {
    api.openLanding();
  } else {
    api.openSession(target.desiredSessionId);
  }
}

export function LodySurfacePool(props: LodySurfacePoolProps) {
  const viewer = useMemo(
    () => ({ name: props.viewer.name, avatarUrl: props.viewer.avatarUrl }),
    [props.viewer.avatarUrl, props.viewer.name],
  );
  const [state, setState] = useState<PoolRenderState>(() => ({
    pool: createLodyKeepalivePool(currentPoolCapacity()),
    definitions: [],
    targetToken: null,
  }));
  const stateRef = useRef(state);
  const claimsRef = useRef(createLodySurfaceIdentityClaims());

  const wantedToken = props.target === null ? null : tokenFor(props.target);
  const addressToken = props.target === null
    ? null
    : `${props.target.desiredArchive}:${props.target.desiredSessionId ?? ""}`;
  let rendered = state;
  if (wantedToken !== state.targetToken) {
    rendered = props.target === null
      ? transitionToNoTarget(state)
      : transitionToTarget(state, props.target, tokenFor(props.target), currentPoolCapacity());
    setState(rendered);
  }
  stateRef.current = rendered;

  const activeEntryId = rendered.pool.activeEntryId;
  const activeEntryIdRef = useRef<string | null>(activeEntryId);
  activeEntryIdRef.current = activeEntryId;
  const targetRef = useRef(props.target);
  targetRef.current = props.target;
  const onApiReadyRef = useRef(props.onApiReady);
  onApiReadyRef.current = props.onApiReady;
  const onActiveSessionChangeRef = useRef(props.onActiveSessionChange);
  onActiveSessionChangeRef.current = props.onActiveSessionChange;
  const apiByEntryRef = useRef(new Map<string, LodySessionSurfaceApi>());

  const publish = useCallback((entryId: string, api: LodySessionSurfaceApi): void => {
    if (activeEntryIdRef.current !== entryId) return;
    const target = targetRef.current;
    if (target === null) return;
    onApiReadyRef.current?.(api);
    const matches = routeMatches(api, target);
    markLodyActivationPhase(target.endpoints.platformUrl, "address-reconciliation", {
      navigated: !matches,
    });
    if (!matches) {
      navigateToTarget(api, target);
      return;
    }
    onActiveSessionChangeRef.current?.(api.activeSessionId());
  }, []);

  const onSurfaceApiReady = useCallback(
    (entryId: string, api: LodySessionSurfaceApi | null): void => {
      if (api === null) {
        apiByEntryRef.current.delete(entryId);
        if (activeEntryIdRef.current === entryId) onApiReadyRef.current?.(null);
        return;
      }
      if (activeEntryIdRef.current !== entryId) return;
      apiByEntryRef.current.set(entryId, api);
      publish(entryId, api);
    },
    [publish],
  );

  const onSurfaceRoute = useCallback((entryId: string, sessionId: string | null): void => {
    if (activeEntryIdRef.current !== entryId) return;
    onActiveSessionChangeRef.current?.(sessionId);
  }, []);

  const applyIdentity = useCallback((entryId: string, identity: LodySurfaceIdentity) => {
    const current = stateRef.current;
    const decision = reportLodySurfaceIdentity(current.pool, entryId, identity);
    const activeWasDisposed = decision.dispose.includes(current.pool.activeEntryId ?? "");
    const next = {
      pool: decision.pool,
      definitions: retainDefinitions(current.definitions, decision.pool),
      // A mismatch of the active entry remounts the current target fresh.
      targetToken: activeWasDisposed && decision.pool.activeEntryId === null
        ? null
        : current.targetToken,
    };
    stateRef.current = next;
    setState(next);
    return decision;
  }, []);

  const onSurfaceIdentityClaim = useCallback(async (
    entryId: string,
    mountKey: string,
    identity: LodySurfaceIdentity,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const decision = applyIdentity(entryId, identity);
    if (decision.entryId !== entryId) return false;
    return await claimsRef.current.claim(identity, mountKey, signal);
  }, [applyIdentity]);

  const onSurfaceIdentity = useCallback((entryId: string, identity: LodySurfaceIdentity): void => {
    applyIdentity(entryId, identity);
  }, [applyIdentity]);

  const onSurfaceContinuityLost = useCallback((entryId: string): void => {
    const current = stateRef.current;
    const decision = discontinueLodySurface(current.pool, entryId);
    const next = {
      ...current,
      pool: decision.pool,
      definitions: retainDefinitions(current.definitions, decision.pool),
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const callbacksByEntryRef = useRef(new Map<string, SurfaceCallbacks>());
  const callbacksFor = (entryId: string, mountKey: string): SurfaceCallbacks => {
    const existing = callbacksByEntryRef.current.get(mountKey);
    if (existing !== undefined) return existing;
    const created: SurfaceCallbacks = {
      onIdentityClaim: (identity, signal) =>
        onSurfaceIdentityClaim(entryId, mountKey, identity, signal),
      onIdentity: (identity) => onSurfaceIdentity(entryId, identity),
      onSurfaceReleased: () => claimsRef.current.release(mountKey),
      onContinuityLost: () => onSurfaceContinuityLost(entryId),
      onApiReady: (api) => onSurfaceApiReady(entryId, api),
      onActiveSessionChange: (sessionId) => onSurfaceRoute(entryId, sessionId),
    };
    callbacksByEntryRef.current.set(mountKey, created);
    return created;
  };

  useLayoutEffect(() => {
    if (activeEntryId === null) {
      onApiReadyRef.current?.(null);
      return;
    }
    const target = targetRef.current;
    if (target !== null) {
      markLodyActivationPhase(target.endpoints.platformUrl, "active-flip-commit");
    }
    const api = apiByEntryRef.current.get(activeEntryId);
    if (api === undefined) {
      onApiReadyRef.current?.(null);
      return;
    }
    publish(activeEntryId, api);
  }, [activeEntryId, addressToken, publish, wantedToken]);

  const liveIds = rendered.pool.entries.map((entry) => entry.entryId).join("\u0000");
  const liveMountKeys = rendered.definitions.map((definition) => definition.mountKey).join("\u0000");
  useEffect(() => {
    const keep = new Set(liveIds === "" ? [] : liveIds.split("\u0000"));
    for (const entryId of apiByEntryRef.current.keys()) {
      if (!keep.has(entryId)) apiByEntryRef.current.delete(entryId);
    }
  }, [liveIds]);

  useEffect(() => {
    const keep = new Set(liveMountKeys === "" ? [] : liveMountKeys.split("\u0000"));
    for (const mountKey of callbacksByEntryRef.current.keys()) {
      if (!keep.has(mountKey)) callbacksByEntryRef.current.delete(mountKey);
    }
  }, [liveMountKeys]);

  useEffect(() => {
    const applyCapacity = (): void => {
      setState((current) => {
        const capacity = currentPoolCapacity();
        if (capacity === current.pool.capacity) return current;
        const resized = resizeLodyKeepalivePool(current.pool, capacity);
        const next = {
          ...current,
          pool: resized.pool,
          definitions: retainDefinitions(current.definitions, resized.pool),
        };
        stateRef.current = next;
        return next;
      });
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === LODY_KEEPALIVE_STORAGE_KEY) applyCapacity();
    };
    window.addEventListener("storage", onStorage);
    const unsubscribe = subscribeLodyKeepalivePolicy(applyCapacity);
    return () => {
      window.removeEventListener("storage", onStorage);
      unsubscribe();
    };
  }, []);

  useEffect(() => () => {
    apiByEntryRef.current.clear();
    callbacksByEntryRef.current.clear();
  }, []);

  const definitions = new Map(rendered.definitions.map((item) => [item.entryId, item]));
  const surfaces = rendered.pool.entries.flatMap((entry) => {
    const definition = definitions.get(entry.entryId);
    if (definition === undefined) return [];
    const current = entry.entryId === activeEntryId && props.target !== null;
    // Use the canonical per-entry object so ordinary shell/address renders do
    // not pierce `RetainedSessionSurfaceContent`'s shallow memo comparison.
    const target = definition.target;
    const callbacks = callbacksFor(entry.entryId, definition.mountKey);
    const surface: LodySessionSurfaceHostProps = {
      surfaceKey: definition.mountKey,
      endpoints: target.endpoints,
      viewer,
      workspaceTitle: target.workspaceTitle,
      hidden: !current || !props.visible,
      active: current,
      railHost: props.railHost,
      rail: props.rail,
      readOnly: target.readOnly,
      identityValidationGeneration: entry.generation,
      ...callbacks,
    };
    if (current && props.surfaceTabs !== undefined) surface.surfaceTabs = props.surfaceTabs;
    if (target.initialSessionId !== undefined) surface.initialSessionId = target.initialSessionId;
    if (target.shared !== undefined) surface.shared = target.shared;
    return [surface];
  });

  return surfaces.length === 0 ? null : <props.Surface surfaces={surfaces} />;
}
