import { describe, expect, it } from 'vitest';
import {
  CONVEX_AUTH_ERROR_CODE,
  CONVEX_AUTH_ERROR_KIND,
  getConvexAuthErrorCode,
  isConvexAuthErrorData,
  isConvexError,
  isConvexUnauthenticatedError,
} from '../src/auth';

describe('Convex auth error contract', () => {
  it('recognizes structured unauthenticated errors from Convex', () => {
    const error = Object.assign(new Error('server error'), {
      name: 'ConvexError',
      data: {
        kind: CONVEX_AUTH_ERROR_KIND,
        code: CONVEX_AUTH_ERROR_CODE.unauthenticated,
      },
      [Symbol.for('ConvexError')]: true,
    });

    expect(isConvexUnauthenticatedError(error)).toBe(true);
    expect(isConvexError(error)).toBe(true);
    expect(getConvexAuthErrorCode(error)).toBe(CONVEX_AUTH_ERROR_CODE.unauthenticated);
  });

  it('does not classify message-only server errors as authentication failures', () => {
    expect(isConvexUnauthenticatedError(new Error('Unauthorized'))).toBe(false);
    expect(
      isConvexUnauthenticatedError({
        data: {
          kind: CONVEX_AUTH_ERROR_KIND,
          code: CONVEX_AUTH_ERROR_CODE.unauthenticated,
        },
      })
    ).toBe(false);
    expect(isConvexAuthErrorData({ kind: CONVEX_AUTH_ERROR_KIND, code: 'unknown' })).toBe(false);
    expect(isConvexError(new Error('ordinary failure'))).toBe(false);
    expect(getConvexAuthErrorCode({ data: null })).toBeNull();
  });
});
