import { ApiRequestError } from './api.js';

export function caughtErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** The one spelling of "this session is dead" for control-plane calls. */
export function isUnauthorized(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.status === 401;
}
