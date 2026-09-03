/** The small set of values that may change when a retained surface activates. */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LodyRailBinding } from "./SessionSurface.js";
import type { SurfaceTabsBinding } from "./surface-tabs.js";

export interface LodySurfaceActiveState {
  active: boolean;
  hidden: boolean;
  railHost: HTMLElement | null | undefined;
  rail: LodyRailBinding | undefined;
  surfaceTabs: SurfaceTabsBinding | undefined;
  identityValidationGeneration: number;
}

const DEFAULT_ACTIVE_STATE: LodySurfaceActiveState = {
  active: true,
  hidden: false,
  railHost: undefined,
  rail: undefined,
  surfaceTabs: undefined,
  identityValidationGeneration: 0,
};

const LodySurfaceActiveContext = createContext(DEFAULT_ACTIVE_STATE);

export function LodySurfaceActiveProvider(props: {
  active: boolean | undefined;
  hidden: boolean | undefined;
  railHost: HTMLElement | null | undefined;
  rail: LodyRailBinding | undefined;
  surfaceTabs: SurfaceTabsBinding | undefined;
  identityValidationGeneration: number | undefined;
  children: ReactNode;
}) {
  const active = props.active !== false;
  const hidden = props.hidden === true;
  const identityValidationGeneration = props.identityValidationGeneration ?? 0;
  const value = useMemo<LodySurfaceActiveState>(
    () => ({
      active,
      hidden,
      railHost: props.railHost,
      rail: props.rail,
      surfaceTabs: props.surfaceTabs,
      identityValidationGeneration,
    }),
    [
      active,
      hidden,
      identityValidationGeneration,
      props.rail,
      props.railHost,
      props.surfaceTabs,
    ],
  );
  return (
    <LodySurfaceActiveContext.Provider value={value}>
      {props.children}
    </LodySurfaceActiveContext.Provider>
  );
}

export function useLodySurfaceActiveState(): LodySurfaceActiveState {
  return useContext(LodySurfaceActiveContext);
}
