/**
 * Closing one member's live connections to another member's box.
 *
 * The box gateway tracks every hijacked connection by identity and closes the
 * matching ones on `POST /admin/drain` with `{"membershipId": …}`
 * (`packages/box/gateway/main.go`). That door has existed since identity phase 2
 * and nothing in the control plane had ever called it; revoking a session share
 * is the first thing that needs to (plans/LODY-SHARING.md §5).
 *
 * WHY IT IS BEST EFFORT. The row is already gone by the time this runs, so the
 * grantee's next connect is refused whatever happens here. What the drain buys
 * is the difference between "revoked" and "revoked and disconnected", which for
 * a WebSocket checked once at upgrade is a live session's worth of minutes. A
 * failure is therefore logged and swallowed rather than failing the revoke.
 *
 * WHY THE WORKSPACE TOKEN. `/admin/drain` is an operator surface: the gateway
 * refuses it to anything but an owner or admin ticket, and the per-workspace
 * static token presents as the owner — which is what `workspaceTunnels.proxy`
 * already falls back to when no credential is supplied.
 */
import { machineFor, providerForVmId } from "./machines.js";
import type { CoreRuntime } from "./runtime.js";
import { requireWorkspaceWebAppAuth, WEBAPP_TOKEN_HEADER } from "./webapp-tickets.js";

/** The gateway's own port. Not a parameter: 7445 is the only proxied box port
 * and `webApp` refuses anything else. */
const GATEWAY_PORT = 7445;

export async function drainWorkspaceMemberConnections(
  runtime: CoreRuntime,
  workspaceId: string,
  targetMembershipId: string,
  granteeMembershipId: string,
): Promise<boolean> {
  const machine = await machineFor(runtime.db, workspaceId, targetMembershipId);
  if (machine === null || machine.state === "destroyed" || machine.vm_id === null) return false;
  const auth = requireWorkspaceWebAppAuth(runtime.providers.webAppAuth);
  const credential = await auth.tokenFor(workspaceId);
  const request = new Request("https://box.invalid/admin/drain", {
    method: "POST",
    headers: { "content-type": "application/json", [WEBAPP_TOKEN_HEADER]: credential },
    body: JSON.stringify({ membershipId: granteeMembershipId }),
  });
  const provider = providerForVmId(runtime, machine.vm_id);
  const tunnels = runtime.providers.workspaceTunnels;
  const response = provider.proxyWebApp !== undefined
    ? await provider.proxyWebApp(machine.vm_id, GATEWAY_PORT, "/admin/drain", request)
    : tunnels !== undefined && machine.tunnel_hostname !== null
      ? await tunnels.proxy(
          machine.tunnel_hostname,
          workspaceId,
          GATEWAY_PORT,
          "/admin/drain",
          request,
          credential,
        )
      : null;
  if (response === null) return false;
  await response.body?.cancel();
  return response.status >= 200 && response.status < 300;
}
