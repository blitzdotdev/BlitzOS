import type { Hono } from "hono";
import type { Principal, PrincipalSource } from "./principals.js";
import type { VmProvider, VolumeProvider } from "./providers/types.js";

export interface BoxIdentity {
  id: string;
  principalId: string;
  workspaceId: string | null;
  isBroker: boolean;
}

export type AppEnv = {
  Bindings: { DB: D1Database };
  Variables: { principal: Principal; box: BoxIdentity };
};

export interface AppDependencies {
  vmProvider: VmProvider;
  volumeProvider: VolumeProvider;
  principalSource: PrincipalSource;
}

export type ControlPlaneApp = Hono<AppEnv>;
