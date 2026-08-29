import type { CurrentUser } from './current-user';

type PostHogIdentityClient = {
  identify: (
    distinctId: string,
    properties?: Record<string, unknown>,
    setOnceProperties?: Record<string, unknown>
  ) => void;
};

export function getPostHogPersonProperties(user: CurrentUser): Record<string, unknown> {
  return {
    email: user.email,
    name: user.name,
  };
}

export function getPostHogPersonSetOnceProperties(): Record<string, unknown> {
  return {
    first_identified_source: 'lody_web',
  };
}

function isCurrentUser(value: CurrentUser | string): value is CurrentUser {
  return typeof value === 'object' && value !== null;
}

// Two call shapes are supported on purpose:
//  - identifyPostHogUser(client, user)            — derives person props from CurrentUser (web).
//  - identifyPostHogUser(client, userId, props?)  — raw distinct id + arbitrary props (CLI/Convex parity).
// Rejected splitting into two names: callers across clients expect one identity
// entrypoint, and the CurrentUser form already resolves to `client.identify(user.id, ...)`.
export function identifyPostHogUser(
  postHog: PostHogIdentityClient | null | undefined,
  user: CurrentUser | null | undefined
): void;
export function identifyPostHogUser(
  postHog: PostHogIdentityClient | null | undefined,
  userId: string | null | undefined,
  props?: Record<string, unknown>
): void;
export function identifyPostHogUser(
  postHog: PostHogIdentityClient | null | undefined,
  userOrId: CurrentUser | string | null | undefined,
  props?: Record<string, unknown>
): void {
  if (!postHog || !userOrId) {
    return;
  }

  // Do not write `$internal_or_test_user: false`: PostHog internal/test filters
  // commonly match "is set", so a false value can still hide real users.
  if (isCurrentUser(userOrId)) {
    postHog.identify(
      userOrId.id,
      getPostHogPersonProperties(userOrId),
      getPostHogPersonSetOnceProperties()
    );
    return;
  }

  postHog.identify(userOrId, props);
}
