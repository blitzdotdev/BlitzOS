/** Fire-and-forget daemon identity validation for a reactivated surface. */
import { useEffect, useRef } from "react";
import type { LodySurfaceIdentity } from "./keepalive-pool.js";
import {
  fetchLodyPlatformSnapshot,
  type LodyPlatformFetchOptions,
} from "./platform-snapshot.js";
import type { LodyRuntimeEndpoints } from "./runtime.js";
import { useLodySurfaceActiveState } from "./surface-active-context.js";

export function LodySurfaceIdentityRevalidation(props: {
  endpoints: LodyRuntimeEndpoints;
  onIdentity?: (identity: LodySurfaceIdentity) => void;
}) {
  const { active, identityValidationGeneration } = useLodySurfaceActiveState();
  const onIdentityRef = useRef(props.onIdentity);
  onIdentityRef.current = props.onIdentity;
  const { endpoints } = props;
  useEffect(() => {
    if (!active || identityValidationGeneration === 0) return undefined;
    const controller = new AbortController();
    const options: LodyPlatformFetchOptions = { signal: controller.signal };
    if (endpoints.fetchImpl !== undefined) options.fetchImpl = endpoints.fetchImpl;
    void fetchLodyPlatformSnapshot(endpoints.platformUrl, options)
      .then((validated) => {
        if (controller.signal.aborted) {
          return;
        }
        if (validated === null) {
          return;
        }
        onIdentityRef.current?.({
          machineId: validated.machineId,
          lwWorkspaceId: validated.workspace.workspaceId,
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [active, endpoints.fetchImpl, endpoints.platformUrl, identityValidationGeneration]);
  return null;
}
