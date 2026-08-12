import { useMemo } from "react";
import { createControlPlaneClient } from "./api.js";
import { Cockpit } from "./Cockpit.js";
import { useStandalonePorts } from "./device-state.js";
import { standaloneResolver } from "./resolver.js";

export function StandaloneCockpit({ controlPlaneBaseUrl = "" }: { controlPlaneBaseUrl?: string }): React.JSX.Element {
  const [ports, setPorts] = useStandalonePorts();
  const client = useMemo(() => createControlPlaneClient(controlPlaneBaseUrl), [controlPlaneBaseUrl]);
  const resolver = useMemo(() => standaloneResolver(ports), [ports]);
  return <Cockpit client={client} resolver={resolver} standaloneSettings={{ ports, onSave: setPorts }} />;
}
