import { useMemo } from "react";
import { createControlPlaneClient } from "./api.js";
import CloudApp from "./CloudApp.js";
import { useStandalonePorts } from "./device-state.js";
import { standaloneResolver } from "./resolver.js";
import { InviteLandingPage } from "./components/InviteLandingPage.js";

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
  const invite = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})\/?$/u);
  if (invite?.[1] !== undefined) return <InviteLandingPage client={client} code={invite[1]} />;
  return <CloudApp client={client} resolver={resolver} />;
}
