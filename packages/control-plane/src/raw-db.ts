import { D1Adapter } from "teenybase/worker";
import type { Db, Query } from "../core/db.js";

/**
 * Minimal Db implementation over a D1 binding, using teenybase's exported
 * D1Adapter for bind/result normalization. Replaces the former
 * `new $DatabaseRawImpl(env.DB)` construction; teenybase@0.0.14 does not
 * export $DatabaseRawImpl from "teenybase/worker".
 */
export function rawDb(d1: D1Database): Db {
  const adapter = new D1Adapter(d1);
  return {
    rawSQL<T>(query: Query) {
      return {
        run: async (): Promise<T[] | null> => {
          const result = await adapter.run<T>(query.q, query.v);
          if (!result.success) throw new Error(result.error ?? "SQL error");
          return result.results;
        },
      };
    },
    rawSQLTransaction<T>(queries: Query[]) {
      return {
        run: async (): Promise<T[][] | null> => {
          const results = await adapter.runBatch<T>(
            queries.map(({ q, v }) => ({ q, v })),
          );
          return results.map((result) => {
            // Same contract as rawSQL above. Callers read row counts to decide
            // whether a guarded write landed, so a failed statement reported as
            // an empty result set would read as "the guard refused" and be
            // swallowed as a 409 instead of surfacing the error.
            if (!result.success) throw new Error(result.error ?? "SQL error");
            return result.results;
          });
        },
      };
    },
  };
}
