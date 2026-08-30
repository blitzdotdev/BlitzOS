import { stripVTControlCharacters } from 'node:util';

import type { BuiltinCliType } from '@lody/shared';

const MAX_AUTHENTICATION_OUTPUT_BUFFER = 32_768;
const AUTHORIZATION_URL_PATTERN = /https:\/\/[^\s"'<>]+/gu;
// Kimi currently emits 4-4 codes while Codex emits 4-5. Keep the upper
// bound narrow so unrelated IDs in provider output are not exposed as codes.
const DEVICE_USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/u;

export type ParsedBuiltinAuthorization = {
  authorizationUrl: string;
  userCode?: string;
  acceptsAuthorizationCode?: boolean;
  expiresInSeconds?: number;
};

function hasDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isTrustedAuthorizationUrl(agentType: BuiltinCliType, url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (agentType === 'claude') {
    return (
      (hasDomain(url.hostname, 'claude.com') || hasDomain(url.hostname, 'claude.ai')) &&
      url.pathname.includes('/oauth/')
    );
  }
  if (agentType === 'codex') {
    return (
      url.hostname === 'auth.openai.com' &&
      (url.pathname.startsWith('/codex/device') || url.pathname.startsWith('/oauth/authorize'))
    );
  }
  if (agentType === 'grok') {
    return (
      hasDomain(url.hostname, 'accounts.x.ai') &&
      (url.pathname.startsWith('/oauth2/device') || url.pathname.startsWith('/device'))
    );
  }
  return hasDomain(url.hostname, 'kimi.com') && url.pathname.startsWith('/code/authorize_device');
}

function findAuthorizationUrl(agentType: BuiltinCliType, output: string): URL | undefined {
  for (const match of output.matchAll(AUTHORIZATION_URL_PATTERN)) {
    const candidate = match[0].replace(/[),.;]+$/u, '');
    try {
      const url = new URL(candidate);
      if (isTrustedAuthorizationUrl(agentType, url)) return url;
    } catch {
      // Ignore incomplete URL chunks until the rest of the output arrives.
    }
  }
  return undefined;
}

function parseExpiresInSeconds(output: string): number | undefined {
  const seconds = /\bexpires in (\d+)s\b/iu.exec(output)?.[1];
  if (seconds) return Number.parseInt(seconds, 10);
  const minutes = /\bexpires in (\d+) minutes?\b/iu.exec(output)?.[1];
  if (minutes) return Number.parseInt(minutes, 10) * 60;
  return undefined;
}

function parseAuthorization(
  agentType: BuiltinCliType,
  output: string
): ParsedBuiltinAuthorization | undefined {
  const authorizationUrl = findAuthorizationUrl(agentType, output);
  if (!authorizationUrl) return undefined;

  const userCode =
    authorizationUrl.searchParams.get('user_code') ?? DEVICE_USER_CODE_PATTERN.exec(output)?.[0];
  const expiresInSeconds = parseExpiresInSeconds(output);
  return {
    authorizationUrl: authorizationUrl.toString(),
    ...(userCode ? { userCode } : {}),
    ...(agentType === 'claude' ? { acceptsAuthorizationCode: true } : {}),
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
  };
}

/**
 * Converts pinned provider CLI text into a small UI-safe authorization event.
 * The parser is incremental because URLs and device codes can cross stdio chunks.
 */
export class BuiltinAuthenticationOutputParser {
  private output = '';
  private lastAuthorization = '';

  constructor(private readonly agentType: BuiltinCliType) {}

  push(chunk: string): ParsedBuiltinAuthorization | undefined {
    this.output = `${this.output}${stripVTControlCharacters(chunk)}`.slice(
      -MAX_AUTHENTICATION_OUTPUT_BUFFER
    );
    const authorization = parseAuthorization(this.agentType, this.output);
    if (!authorization) return undefined;
    const fingerprint = JSON.stringify(authorization);
    if (fingerprint === this.lastAuthorization) return undefined;
    this.lastAuthorization = fingerprint;
    return authorization;
  }
}
