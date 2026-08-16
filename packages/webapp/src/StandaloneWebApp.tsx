import { useMemo } from "react";
import { createControlPlaneClient } from "./api.js";
import CloudApp from "./CloudApp.js";
import { useStandalonePorts } from "./device-state.js";
import { standaloneResolver } from "./resolver.js";

export function StandaloneWebApp({ controlPlaneBaseUrl = "" }: { controlPlaneBaseUrl?: string }): React.JSX.Element {
  const [ports] = useStandalonePorts();
  const client = useMemo(() => createControlPlaneClient(controlPlaneBaseUrl), [controlPlaneBaseUrl]);
  const controlPlaneOrigin = useMemo(
    () => new URL(controlPlaneBaseUrl || window.location.origin, window.location.href).origin,
    [controlPlaneBaseUrl],
  );
  const resolver = useMemo(
    () => standaloneResolver(ports, controlPlaneOrigin),
    [controlPlaneOrigin, ports],
  );
  return <CloudApp client={client} resolver={resolver} />;
}
