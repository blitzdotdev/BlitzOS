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
      item.entryId === requested.entryId ? { ...item, target } : item);
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
    if (!routeMatches(api, target)) {
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

  useLayoutEffect(() => {
    if (activeEntryId === null) {
      onApiReadyRef.current?.(null);
      return;
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
  }, [liveIds]);

  const poolRef = useRef(rendered.pool);
  poolRef.current = rendered.pool;
  useEffect(() => () => {
    disposeLodyKeepalivePool(poolRef.current);
    apiByEntryRef.current.clear();
  }, []);

  const definitions = new Map(rendered.definitions.map((item) => [item.entryId, item]));
  const surfaces = rendered.pool.entries.flatMap((entry) => {
    const definition = definitions.get(entry.entryId);
    if (definition === undefined) return [];
    const current = entry.entryId === activeEntryId && props.target !== null;
    const target = current && props.target !== null ? props.target : definition.target;
    const surface: LodySessionSurfaceHostProps = {
      surfaceKey: entry.entryId,
      endpoints: target.endpoints,
      viewer,
      workspaceTitle: target.workspaceTitle,
      hidden: !current || !props.visible,
      active: current,
      railHost: current ? props.railHost : null,
      rail: props.rail,
      readOnly: target.readOnly,
      identityValidationGeneration: entry.generation,
      onIdentity: (identity: LodySurfaceIdentity) => onSurfaceIdentity(entry.entryId, identity),
      onContinuityLost: () => onSurfaceContinuityLost(entry.entryId),
      onApiReady: (api: LodySessionSurfaceApi | null) => onSurfaceApiReady(entry.entryId, api),
      onActiveSessionChange: (sessionId: string | null) =>
        onSurfaceRoute(entry.entryId, sessionId),
    };
    if (current && props.surfaceTabs !== undefined) surface.surfaceTabs = props.surfaceTabs;
    if (target.initialSessionId !== undefined) surface.initialSessionId = target.initialSessionId;
    if (target.shared !== undefined) surface.shared = target.shared;
    return [surface];
  });

  return surfaces.length === 0 ? null : <props.Surface surfaces={surfaces} />;
}
