import { describe, expect, it } from 'vitest';

import { BuiltinAuthenticationOutputParser } from './acp-authentication-output';

describe('BuiltinAuthenticationOutputParser', () => {
  it('parses Codex device authorization across output chunks', () => {
    const parser = new BuiltinAuthenticationOutputParser('codex');

    expect(
      parser.push(
        'Open this link in your browser\nhttps://auth.openai.com/codex/device\n' +
          'Enter this one-time '
      )
    ).toEqual({ authorizationUrl: 'https://auth.openai.com/codex/device' });
    expect(parser.push('code (expires in 15 minutes)\nDQGR-SB46E\n')).toEqual({
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'DQGR-SB46E',
      expiresInSeconds: 900,
    });
    expect(parser.push('Waiting for authorization\n')).toBeUndefined();
  });

  it('parses Kimi device authorization and the code embedded in its URL', () => {
    const parser = new BuiltinAuthenticationOutputParser('kimi');

    expect(
      parser.push(
        'Opening browser for Kimi device login: ' +
          'https://www.kimi.com/code/authorize_device?user_code=GI5T-ACD0\n' +
          'Code expires in 1800s.\n'
      )
    ).toEqual({
      authorizationUrl: 'https://www.kimi.com/code/authorize_device?user_code=GI5T-ACD0',
      userCode: 'GI5T-ACD0',
      expiresInSeconds: 1800,
    });
  });

  it('parses Grok device authorization from the trusted xAI account host', () => {
    const parser = new BuiltinAuthenticationOutputParser('grok');
    const url = 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH';

    expect(parser.push(`Open this URL to authenticate:\n${url}\n`)).toEqual({
      authorizationUrl: url,
      userCode: 'ABCD-EFGH',
    });
  });

  it('strips terminal hyperlinks and exposes Claude manual-code fallback', () => {
    const parser = new BuiltinAuthenticationOutputParser('claude');
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=state-value';

    expect(
      parser.push(
        `If the browser did not open, visit: \u001b]8;;${url}\u0007\u001b[94m${url}\u001b[39m\u001b]8;;\u0007\n` +
          'Paste code here if prompted > '
      )
    ).toEqual({
      authorizationUrl: url,
      acceptsAuthorizationCode: true,
    });
  });

  it('does not expose URLs outside the provider allowlist', () => {
    const parser = new BuiltinAuthenticationOutputParser('codex');

    expect(parser.push('Open https://attacker.example/codex/device and continue')).toBeUndefined();
  });
});
