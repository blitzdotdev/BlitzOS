import { useEffect, useMemo, useRef } from 'react';
import * as ConvexReact from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';
import { isConvexUnauthenticatedError } from '@lody/shared';
import { useAuthenticatedConvex } from './use-authenticated-convex';

type QuerySnapshot = {
  authSessionId: string | null;
  queryKey: string;
  value: unknown;
};

/**
 * A retained snapshot may only be reused for the same Better Auth session and the
 * same query. Check the snapshot itself first: `snapshot?.authSessionId` is
 * `undefined` when there is no snapshot, which would wrongly compare equal to an
 * absent `authSessionId` and then dereference null.
 */
function matchesSnapshot(
  snapshot: QuerySnapshot | null,
  authSessionId: string | null,
  queryKey: string
): snapshot is QuerySnapshot {
  return (
    snapshot !== null && snapshot.authSessionId === authSessionId && snapshot.queryKey === queryKey
  );
}

/**
 * Convex's useQuery throws query errors during render. Auth expiry is recoverable,
 * so keep it out of React error boundaries and retain the last committed value
 * while the central auth supervisor refreshes the token.
 */
export function useRecoverableConvexQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  ...args: ConvexReact.OptionalRestArgsOrSkip<Query>
): Query['_returnType'] | undefined {
  const { authSessionId, confirmedUnauthenticated, isAuthenticated, requestAuthRecovery } =
    useAuthenticatedConvex();
  const callerSkipped = args[0] === 'skip';
  const skip = callerSkipped || !isAuthenticated;
  const argsObject = (args[0] === undefined || callerSkipped ? {} : args[0]) as Record<
    string,
    Value
  >;
  const queryName = getFunctionName(query);
  const serializedArgs = JSON.stringify(convexToJson(argsObject));
  const queryKey = `${queryName}:${serializedArgs}`;
  const queries = useMemo<ConvexReact.RequestForQueries>(
    () => (skip ? ({} as ConvexReact.RequestForQueries) : { query: { query, args: argsObject } }),
    // Match Convex's useQuery semantics: semantic argument equality owns the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey, skip]
  );
  const result = ConvexReact.useQueries(queries).query as Query['_returnType'] | Error | undefined;
  const snapshotRef = useRef<QuerySnapshot | null>(null);
  const authError = isConvexUnauthenticatedError(result) ? result : null;

  useEffect(() => {
    if (!authError || confirmedUnauthenticated) return;
    requestAuthRecovery();
  }, [authError, confirmedUnauthenticated, requestAuthRecovery]);

  useEffect(() => {
    if (skip || result === undefined || result instanceof Error) return;
    snapshotRef.current = {
      authSessionId,
      queryKey,
      value: result,
    };
  }, [authSessionId, queryKey, queryName, result, skip]);

  if (result instanceof Error) {
    if (!authError) throw result;
    const snapshot = snapshotRef.current;
    return matchesSnapshot(snapshot, authSessionId, queryKey)
      ? (snapshot.value as Query['_returnType'])
      : undefined;
  }

  // Retain the last committed value whenever the subscription is transiently
  // skipped by a lost/refreshing auth state (offline blips, token refresh,
  // recovery). Without this, `skip` flapping true drops the query to
  // `undefined` and the sidebar churns — the private icon flickers and
  // teammates' rows flash out and back. We only fall through to `undefined`
  // when the caller explicitly skipped or the user is confirmed logged out
  // (where retaining stale team data would be wrong). The snapshot's
  // `authSessionId` + `queryKey` guard keeps this scoped to the same user and
  // query, so switching account/workspace never reuses a stale value.
  if (skip && !callerSkipped && !confirmedUnauthenticated) {
    const snapshot = snapshotRef.current;
    if (matchesSnapshot(snapshot, authSessionId, queryKey)) {
      return snapshot.value as Query['_returnType'];
    }
  }

  return result;
}

/** Public queries must run before authentication, so they cannot use the
 * authenticated query gate above. Keep the direct Convex hook isolated here. */
export function usePublicConvexQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  ...args: ConvexReact.OptionalRestArgsOrSkip<Query>
): Query['_returnType'] | undefined {
  return ConvexReact.useQuery(query, ...args);
}
