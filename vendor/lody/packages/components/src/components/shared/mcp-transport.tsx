import { Globe, SquareTerminal } from 'lucide-react';
import type { McpTransport } from '@lody/shared';
import { cn } from '@/lib/utils';

/** Selection order for every transport picker. */
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http'];

/** Transport names stay literal — `stdio` and Streamable HTTP are the MCP
 *  spec's own identifiers, so they read the same in every locale. */
export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'Streamable HTTP',
};

/** For width-constrained controls (the segmented transport switch). */
export const MCP_TRANSPORT_SHORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'HTTP',
};

export function McpTransportIcon({
  transport,
  className,
}: {
  transport: McpTransport;
  className?: string;
}) {
  const Icon = transport === 'http' ? Globe : SquareTerminal;
  return <Icon className={cn('h-3.5 w-3.5', className)} aria-hidden="true" />;
}
