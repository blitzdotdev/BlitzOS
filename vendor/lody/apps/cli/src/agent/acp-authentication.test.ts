import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/utils/logger';
import { AcpAuthenticationManager, probeBuiltinAuthentication } from './acp-authentication';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createFakeChild(options: { ignoreSigterm?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.pid = undefined;
  child.stdout = null;
  child.stderr = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && options.ignoreSigterm) return true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 0;
    queueMicrotask(() => child.emit('exit', child.exitCode, signal));
    return true;
  });
  return child;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AcpAuthenticationManager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reserves the login slot before asynchronous launch preparation', async () => {
    const loginShellEnv = createDeferred<Record<string, string>>();
    const successfulChild = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        successfulChild.exitCode = 0;
        successfulChild.emit('exit', 0, null);
      });
      return successfulChild;
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: vi.fn(() => loginShellEnv.promise),
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await expect(manager.authenticate({ requestId: 'auth-2', ...input })).resolves.toEqual({
      success: false,
      disposition: 'error',
      error: 'Kimi Code authentication is already running',
    });

    loginShellEnv.resolve({});
    await expect(firstAttempt).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it.each([
    {
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
      command: '/test/claude',
      args: ['auth', 'login', '--claudeai'],
    },
    {
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/test/codex' },
      command: '/test/codex',
      args: ['login', '--device-auth'],
    },
    {
      agentType: 'grok',
      runtimeOverrides: { grokPath: '/test/grok' },
      command: '/test/grok',
      args: ['login', '--device-auth'],
    },
  ])(
    'runs the official $agentType login flow',
    async ({ agentType, runtimeOverrides, command, args }) => {
      const successfulChild = createFakeChild();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          successfulChild.exitCode = 0;
          successfulChild.emit('exit', 0, null);
        });
        return successfulChild;
      });
      const manager = new AcpAuthenticationManager(createSilentLogger(), {
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      });

      await expect(
        manager.authenticate({
          requestId: `auth-${agentType}`,
          cliType: 'builtin',
          agentType,
          runtimeOverrides,
        })
      ).resolves.toEqual({ success: true, disposition: 'authenticated' });
      expect(spawnProcess).toHaveBeenCalledWith(
        command,
        args,
        expect.objectContaining({ cwd: expect.any(String) })
      );
    }
  );

  it('emits a Claude browser authorization event and accepts the fallback code through stdin', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutListening = createDeferred<void>();
    stdout.once('newListener', (event) => {
      if (event === 'data') stdoutListening.resolve();
    });
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const receivedInput: string[] = [];
    stdin.on('data', (chunk) => receivedInput.push(String(chunk)));
    stdin.on('finish', () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    });
    const authorizationReceived = createDeferred<void>();
    const progress = vi.fn((event: { status: string }) => {
      if (event.status === 'authorization') authorizationReceived.resolve();
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-claude',
      cliType: 'builtin',
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
      onProgress: progress,
    });

    await stdoutListening.promise;
    stdout.write(
      'If the browser did not open, visit: ' +
        'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test\n' +
        'Paste code here if prompted > '
    );
    await authorizationReceived.promise;
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'authorization',
        authorizationUrl:
          'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test',
        acceptsAuthorizationCode: true,
      })
    );

    expect(manager.submitAuthorizationCode('claude', 'auth-claude', 'browser-code')).toEqual({
      success: true,
      disposition: 'input-accepted',
    });
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(receivedInput).toEqual(['browser-code\n']);
  });

  it('explains the ChatGPT device-code setting when Codex login exits unsuccessfully', async () => {
    const failedChild = createFakeChild();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          failedChild.exitCode = 1;
          failedChild.emit('exit', 1, null);
        });
        return failedChild;
      }) as never,
      resolveLoginShellEnv: async () => ({}),
    });

    await expect(
      manager.authenticate({
        requestId: 'auth-codex',
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
      })
    ).resolves.toEqual({
      success: false,
      disposition: 'error',
      error:
        'Codex authentication exited with code 1. Make sure device-code login is enabled in your ChatGPT security settings or workspace permissions, then try again.',
    });
  });

  it('cancels launch preparation without spawning and allows an immediate retry', async () => {
    const firstLoginShellEnv = createDeferred<Record<string, string>>();
    const preparationStarted = createDeferred<void>();
    let preparationCalls = 0;
    const resolveLoginShellEnv = vi.fn(() => {
      preparationCalls += 1;
      if (preparationCalls === 1) {
        preparationStarted.resolve();
        return firstLoginShellEnv.promise;
      }
      return Promise.resolve({});
    });
    const successfulChild = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        successfulChild.exitCode = 0;
        successfulChild.emit('exit', 0, null);
      });
      return successfulChild;
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv,
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await preparationStarted.promise;
    expect(resolveLoginShellEnv).toHaveBeenCalledOnce();
    expect(manager.cancel('kimi', 'auth-1')).toEqual({
      success: true,
      disposition: 'cancelled',
    });

    const retryAttempt = manager.authenticate({ requestId: 'auth-2', ...input });
    await expect(retryAttempt).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });

    firstLoginShellEnv.resolve({});
    await expect(firstAttempt).resolves.toEqual({
      success: true,
      disposition: 'cancelled',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it('times out, escalates termination, and releases the login slot for retry', async () => {
    vi.useFakeTimers();
    const stuckChild = createFakeChild({ ignoreSigterm: true });
    const successfulChild = createFakeChild();
    const firstProcessStarted = createDeferred<void>();
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        firstProcessStarted.resolve();
        return stuckChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          successfulChild.exitCode = 0;
          successfulChild.emit('exit', 0, null);
        });
        return successfulChild;
      });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      authenticationTimeoutMs: 10,
      terminationGraceMs: 2,
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await firstProcessStarted.promise;
    await vi.advanceTimersByTimeAsync(12);
    await expect(firstAttempt).resolves.toEqual({
      success: false,
      disposition: 'error',
      error: 'Kimi Code authentication timed out. Please try again.',
    });
    expect(stuckChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(stuckChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await expect(manager.authenticate({ requestId: 'auth-2', ...input })).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
  });
});

describe('probeBuiltinAuthentication', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recognizes an authenticated Claude credential store', async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return child;
    });

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'authenticated' });
    expect(spawnProcess).toHaveBeenCalledWith(
      '/test/claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });

  it('leaves Codex authentication requirements to the ACP adapter', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
        env: { CODEX_API_KEY: '', OPENAI_API_KEY: '' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('returns the Claude subscription method when local credentials are missing', async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    });

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toMatchObject({
      status: 'unauthenticated',
      authMethods: [
        expect.objectContaining({ id: 'claude-ai-login', name: 'Claude subscription' }),
      ],
    });
  });

  it.each(['CODEX_API_KEY', 'OPENAI_API_KEY'])(
    'defers to Codex ACP when %s is set',
    async (key) => {
      const spawnProcess = vi.fn();

      await expect(
        probeBuiltinAuthentication({
          cliType: 'builtin',
          agentType: 'codex',
          runtimeOverrides: { codexPath: '/test/codex' },
          env: { [key]: 'test-key' },
          logger: createSilentLogger(),
          spawnProcess: spawnProcess as never,
          resolveLoginShellEnv: async () => ({}),
        })
      ).resolves.toEqual({ status: 'unknown' });
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  );

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])('defers to Claude ACP when %s is set', async (key) => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        env: { [key]: 'configured' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('detects API-key authentication inherited from the login shell', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({ OPENAI_API_KEY: 'shell-key' }),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('leaves Kimi credential detection to the ACP adapter', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'kimi',
        runtimeOverrides: { kimiPath: '/test/kimi' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
