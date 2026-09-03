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
  LODY_SURFACE_POOL_CAPACITY,
  activateLodySurface,
  createLodyKeepalivePool,
  deactivateLodySurface,
  discontinueLodySurface,
  disposeLodyKeepalivePool,
  lodyKeepaliveEnabled,
  reportLodySurfaceIdentity,
  requestLodySurface,
  type LodyKeepalivePool,
  type LodySurfaceIdentity,
  type LodySurfaceKind,
} from "./keepalive-pool.js";
import type { BlitzViewer } from "./platform.js";
import type { LodyRuntimeEndpoints } from "./runtime.js";
import type { SurfaceTabsBinding } from "./surface-tabs.js";
import { markLodyActivationPhase } from "./surface-activation-performance.js";

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
  target: LodySurfacePoolTarget;
}

interface PoolRenderState {
  pool: LodyKeepalivePool;
  definitions: readonly SurfaceDefinition[];
  targetToken: string | null;
}

interface SurfaceCallbacks {
  onIdentity: (identity: LodySurfaceIdentity) => void;
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

function tokenFor(target: LodySurfacePoolTarget): string {
  return `${target.kind}:${lodyEndpointFingerprint(target.endpoints)}`;
}

/** Props that build the retained provider/runtime body, excluding address hints. */
function sameSurfaceMountTarget(
  left: LodySurfacePoolTarget,
  right: LodySurfacePoolTarget,
): boolean {
  return left.kind === right.kind
    && lodyEndpointFingerprint(left.endpoints) === lodyEndpointFingerprint(right.endpoints)
    && left.endpoints.fetchImpl === right.endpoints.fetchImpl
    && left.endpoints.webSocketConstructor === right.endpoints.webSocketConstructor
    && left.workspaceTitle === right.workspaceTitle
    && left.readOnly === right.readOnly
    && left.shared?.sessionId === right.shared?.sessionId
    && left.initialSessionId === right.initialSessionId;
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
): PoolRenderState {
  const requested = requestLodySurface(state.pool, {
    endpointFingerprint: lodyEndpointFingerprint(target.endpoints),
    kind: target.kind,
  });
  if (requested.entryId === null) return state;
  const activated = activateLodySurface(requested.pool, requested.entryId);
  let definitions = retainDefinitions(state.definitions, activated.pool);
  const existing = definitions.findIndex((item) => item.entryId === requested.entryId);
  if (existing === -1) {
    definitions = [...definitions, { entryId: requested.entryId, target }];
  } else {
    definitions = definitions.map((item) =>
      item.entryId === requested.entryId && !sameSurfaceMountTarget(item.target, target)
        ? { ...item, target }
        : item);
  }
  return { pool: activated.pool, definitions, targetToken: token };
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
  const capacity = useState(() =>
    lodyKeepaliveEnabled() ? LODY_SURFACE_POOL_CAPACITY : 1)[0];
  const [state, setState] = useState<PoolRenderState>(() => ({
    pool: createLodyKeepalivePool(capacity),
    definitions: [],
    targetToken: null,
  }));

  const wantedToken = props.target === null ? null : tokenFor(props.target);
  const addressToken = props.target === null
    ? null
    : `${props.target.desiredArchive}:${props.target.desiredSessionId ?? ""}`;
  let rendered = state;
  if (wantedToken !== state.targetToken) {
    rendered = props.target === null
      ? transitionToNoTarget(state)
      : transitionToTarget(state, props.target, tokenFor(props.target));
    setState(rendered);
  } else if (props.target !== null && state.pool.activeEntryId !== null) {
    const nextTarget = props.target;
    const activeDefinition = state.definitions.find(
      (definition) => definition.entryId === state.pool.activeEntryId,
    );
    if (
      activeDefinition !== undefined
      && !sameSurfaceMountTarget(activeDefinition.target, nextTarget)
    ) {
      rendered = {
        ...state,
        definitions: state.definitions.map((definition) =>
          definition.entryId === state.pool.activeEntryId
            ? { ...definition, target: nextTarget }
            : definition),
      };
      setState(rendered);
    }
  }

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
      if (api === null || activeEntryIdRef.current !== entryId) return;
      apiByEntryRef.current.set(entryId, api);
      publish(entryId, api);
    },
    [publish],
  );

  const onSurfaceRoute = useCallback((entryId: string, sessionId: string | null): void => {
    if (activeEntryIdRef.current !== entryId) return;
    onActiveSessionChangeRef.current?.(sessionId);
  }, []);

  const onSurfaceIdentity = useCallback((entryId: string, identity: LodySurfaceIdentity): void => {
    setState((current) => {
      const decision = reportLodySurfaceIdentity(current.pool, entryId, identity);
      const activeWasDisposed = decision.dispose.includes(current.pool.activeEntryId ?? "");
      return {
        pool: decision.pool,
        definitions: retainDefinitions(current.definitions, decision.pool),
        // A mismatch of the active entry remounts the current target fresh.
        targetToken: activeWasDisposed ? null : current.targetToken,
      };
    });
  }, []);

  const onSurfaceContinuityLost = useCallback((entryId: string): void => {
    setState((current) => {
      const decision = discontinueLodySurface(current.pool, entryId);
      return {
        ...current,
        pool: decision.pool,
        definitions: retainDefinitions(current.definitions, decision.pool),
      };
    });
  }, []);

  const callbacksByEntryRef = useRef(new Map<string, SurfaceCallbacks>());
  const callbacksFor = (entryId: string): SurfaceCallbacks => {
    const existing = callbacksByEntryRef.current.get(entryId);
    if (existing !== undefined) return existing;
    const created: SurfaceCallbacks = {
      onIdentity: (identity) => onSurfaceIdentity(entryId, identity),
      onContinuityLost: () => onSurfaceContinuityLost(entryId),
      onApiReady: (api) => onSurfaceApiReady(entryId, api),
      onActiveSessionChange: (sessionId) => onSurfaceRoute(entryId, sessionId),
    };
    callbacksByEntryRef.current.set(entryId, created);
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
  useEffect(() => {
    const keep = new Set(liveIds === "" ? [] : liveIds.split("\u0000"));
    for (const entryId of apiByEntryRef.current.keys()) {
      if (!keep.has(entryId)) apiByEntryRef.current.delete(entryId);
    }
    for (const entryId of callbacksByEntryRef.current.keys()) {
      if (!keep.has(entryId)) callbacksByEntryRef.current.delete(entryId);
    }
  }, [liveIds]);

  const poolRef = useRef(rendered.pool);
  poolRef.current = rendered.pool;
  useEffect(() => () => {
    disposeLodyKeepalivePool(poolRef.current);
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
    const callbacks = callbacksFor(entry.entryId);
    const surface: LodySessionSurfaceHostProps = {
      surfaceKey: entry.entryId,
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
