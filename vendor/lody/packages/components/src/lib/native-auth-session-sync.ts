import { z } from 'zod';
import { writeAuthBootstrapSnapshot, writeStoredAuthToken } from './auth-bootstrap';
import { normalizeCurrentUserFromSessionUser } from './current-user';

const NativeAuthSessionDataSchema = z
  .object({
    session: z
      .object({
        token: z.string().min(1).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    token: z.string().min(1).nullable().optional(),
    user: z.unknown().nullable().optional(),
  })
  .passthrough()
  .refine(
    (value) => value.session !== undefined || value.token !== undefined || value.user !== undefined,
    {
      message: 'Session result must include session, token, or user',
    }
  );

const WrappedSessionResultSchema = z
  .object({
    data: z.unknown().nullable().optional(),
  })
  .passthrough();

type NativeAuthSessionData = z.infer<typeof NativeAuthSessionDataSchema>;

export type NativeAuthSessionSnapshot = {
  token: string | null;
  hasUser: boolean;
};

type SyncNativeAuthSessionOptions = {
  initialResult?: unknown;
  getSession: () => Promise<unknown>;
  persistSessionResult?: (result: unknown) => boolean;
  logger?: Pick<Console, 'warn'>;
};

function hasOwnDataProperty(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'data')
  );
}

function unwrapSessionResult(result: unknown): unknown {
  if (!hasOwnDataProperty(result)) {
    return result;
  }

  const wrapped = WrappedSessionResultSchema.safeParse(result);
  if (!wrapped.success) {
    return result;
  }

  return wrapped.data.data ?? null;
}

function extractNativeAuthSessionData(result: unknown): NativeAuthSessionData | null {
  const parsed = NativeAuthSessionDataSchema.safeParse(unwrapSessionResult(result));
  return parsed.success ? parsed.data : null;
}

export function extractNativeAuthSessionSnapshot(
  result: unknown
): NativeAuthSessionSnapshot | null {
  const data = extractNativeAuthSessionData(result);
  if (!data) {
    return null;
  }

  return {
    token: data.session?.token ?? data.token ?? null,
    hasUser: data.user != null,
  };
}

export function persistNativeAuthSessionResult(result: unknown): boolean {
  const data = extractNativeAuthSessionData(result);
  if (!data) {
    return false;
  }

  const token = data.session?.token ?? data.token ?? null;
  if (token !== null && token !== '') {
    writeStoredAuthToken(token);
  }

  if (data.user != null) {
    try {
      writeAuthBootstrapSnapshot(normalizeCurrentUserFromSessionUser(data.user));
    } catch {
      // Token persistence is the native-login critical path; user bootstrap is best-effort.
    }
  }

  return token !== null && token !== '';
}

export async function syncNativeAuthSession({
  initialResult,
  getSession,
  persistSessionResult = persistNativeAuthSessionResult,
  logger = console,
}: SyncNativeAuthSessionOptions): Promise<boolean> {
  if (initialResult !== undefined && persistSessionResult(initialResult)) {
    return true;
  }

  try {
    return persistSessionResult(await getSession());
  } catch (error) {
    logger.warn('Native auth session getSession failed', error);
    return false;
  }
}
