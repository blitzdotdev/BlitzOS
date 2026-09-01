import dns from 'node:dns';
import { getLogger, type Logger } from './logger';

/**
 * Default the CLI's DNS result order to `ipv4first`.
 *
 * Node >=17 keeps resolver ("verbatim") ordering, so hosts whose resolvers
 * return AAAA records first make `fetch` connect over IPv6 first. On networks
 * with a broken IPv6 path (commonly: TCP connects but TLS is reset/black-holed,
 * which Happy Eyeballs does not recover from because it only covers the TCP
 * connect stage), every undici request fails with `fetch failed` while plain
 * `node:https` — with no connect timeout — may still limp through. Preferring
 * IPv4 restores the pre-Node-17 behavior that all of the CLI's HTTP(S)/WS
 * traffic was built against. Happy Eyeballs (on by default for Node >=20)
 * still falls back to IPv6 when IPv4 is the broken family.
 */

export type DnsResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

const VALID_ORDERS = new Set<DnsResultOrder>(['ipv4first', 'ipv6first', 'verbatim']);
/** Values that mean "leave the runtime default alone". */
const RUNTIME_DEFAULT_VALUES = new Set(['node', 'native', 'default', 'verbatim']);
const DNS_RESULT_ORDER_FLAG = '--dns-result-order';

export interface DnsResultOrderResolution {
  order: DnsResultOrder | null;
  reason: 'explicit-node-flag' | 'env-runtime-default' | 'env-invalid' | 'env' | 'default';
}

function hasExplicitNodeFlag(
  execArgv: readonly string[],
  nodeOptions: string | undefined
): boolean {
  if (
    execArgv.some(
      (arg) => arg === DNS_RESULT_ORDER_FLAG || arg.startsWith(`${DNS_RESULT_ORDER_FLAG}=`)
    )
  ) {
    return true;
  }
  return typeof nodeOptions === 'string' && nodeOptions.includes(DNS_RESULT_ORDER_FLAG);
}

export function resolveDnsResultOrder(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): DnsResultOrderResolution {
  // A user-provided runtime flag (CLI arg or NODE_OPTIONS) always wins.
  if (hasExplicitNodeFlag(execArgv, env.NODE_OPTIONS)) {
    return { order: null, reason: 'explicit-node-flag' };
  }

  const configured = env.LODY_DNS_RESULT_ORDER?.trim().toLowerCase();
  if (configured) {
    if (RUNTIME_DEFAULT_VALUES.has(configured)) {
      // `verbatim` is both a valid order and the runtime default; setting it is a no-op.
      return { order: null, reason: 'env-runtime-default' };
    }
    if (VALID_ORDERS.has(configured as DnsResultOrder)) {
      return { order: configured as DnsResultOrder, reason: 'env' };
    }
    return { order: 'ipv4first', reason: 'env-invalid' };
  }

  return { order: 'ipv4first', reason: 'default' };
}

export function applyDefaultDnsResultOrder(
  options: { logger?: Logger; env?: NodeJS.ProcessEnv } = {}
): void {
  const logger = options.logger ?? getLogger('dns');
  const resolution = resolveDnsResultOrder(options.env);

  if (resolution.order === null) {
    logger.debug(`[dns] keeping runtime DNS result order (${resolution.reason})`);
    return;
  }

  if (resolution.reason === 'env-invalid') {
    logger.warn(
      `[dns] invalid LODY_DNS_RESULT_ORDER value; expected ipv4first|ipv6first|verbatim|node — falling back to ipv4first`
    );
  }

  try {
    dns.setDefaultResultOrder(resolution.order);
    logger.debug(
      `[dns] default DNS result order set to ${resolution.order} (${resolution.reason})`
    );
  } catch (error) {
    // Never let DNS tuning break CLI startup.
    logger.debug(
      `[dns] failed to set DNS result order: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
