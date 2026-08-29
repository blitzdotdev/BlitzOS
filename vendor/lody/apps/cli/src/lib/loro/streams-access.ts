import { getLoroStreamsBaseUrl } from '@lody/shared';
import type { LoroStreamsTokenProvider } from '@lody/platform';

/**
 * Prime the platform token provider before reading its gateway. The hosted
 * token response owns deployment topology; CLI runtime modules must not invent
 * a default or require a second environment-based composition path.
 */
export async function prepareCliStreamsGatewayBaseUrl(
  tokenProvider: LoroStreamsTokenProvider
): Promise<string> {
  await tokenProvider.getToken();
  return getLoroStreamsBaseUrl(tokenProvider.getGatewayBaseUrl());
}
