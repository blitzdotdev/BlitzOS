import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

describe('WinstonLogger', () => {
  it('keeps nested child logger methods bound when passed as callbacks', () => {
    const rootLogger = createLogger({ transports: 'console', level: 'silent' });
    const createChild = rootLogger.child;
    const workspaceLogger = createChild({ workspaceName: 'workspace' });
    const sessionLogger = workspaceLogger.child({ sessionId: 'session' });
    const debug = sessionLogger.debug;

    expect(() => debug('bound logger method')).not.toThrow();
  });
});
