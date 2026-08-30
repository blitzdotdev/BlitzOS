import { Cause, Effect, Exit } from 'effect';

export async function runPromiseEffect<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.match(exit, {
    onFailure: (cause) => {
      throw Cause.squash(cause);
    },
    onSuccess: (value) => value,
  });
}

export function tryPromiseEffect<A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: (error) => error,
  });
}
