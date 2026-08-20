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
          return results.map((result) => result.results);
        },
      };
    },
  };
}
