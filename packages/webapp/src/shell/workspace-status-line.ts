/**
 * The sentence in the footer's left slot.
 *
 * IT USED TO BE ONE FACT AND THAT WAS THE DEFECT (BUG-CV-02). `CloudApp`
 * printed `workspace ${lifecycleStatus}` — the control plane's reading of the
 * MACHINE — and nothing else. A canary box booted with a cloudflared connector
 * that carried zero ready connections: the VM was up, so the machine said
 * `running`, so the footer said `workspace running` for more than seven
 * minutes, while every `/webapp/7445/*` call answered 530 and the member could
 * not open a terminal, a file or a session. The status was true about the
 * machine and useless about the workspace.
 *
 * A member needs BOTH facts, because they lead to different actions. A machine
 * that is not running is something they can start. A machine that runs behind a
 * gateway they cannot reach is something they report, or wait out — and the one
 * thing they must not do is keep clicking as if the shell were fine.
 *
 * ONLY `running` IS QUALIFIED. `creating`, `provisioning`, `parked` and
 * `resuming` all mean an unreachable box already, and they say so in a word the
 * member understands; adding "box unreachable" to `workspace resuming` would
 * describe a boot as an outage. The contradiction this repairs exists in
 * exactly one state.
 */
import type { BoxGatewayHealth } from '../box-gateway-health';
import type { RestWorkspaceStatus } from '../protocol';

/** What the footer says while no workspace is selected yet. */
export const WORKSPACE_PENDING_STATUS = 'workspace pending';

/** The whole sentence for a running machine the browser cannot reach. */
export const WORKSPACE_UNREACHABLE_STATUS = 'workspace running · box unreachable';

export function workspaceStatusLine(
  lifecycleStatus: RestWorkspaceStatus | undefined,
  gateway: BoxGatewayHealth,
): string {
  if (lifecycleStatus === undefined) return WORKSPACE_PENDING_STATUS;
  if (lifecycleStatus === 'running' && gateway === 'unreachable') {
    return WORKSPACE_UNREACHABLE_STATUS;
  }
  return `workspace ${lifecycleStatus}`;
}
