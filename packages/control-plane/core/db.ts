export interface Query {
  q: string;
  v: any[];
}

export interface RawRun<T> {
  run(): Promise<T[] | null>;
}

export interface TransactionRun<T> {
  run(): Promise<T[][] | null>;
}

export interface Db {
  rawSQL<T = Record<string, unknown>>(query: Query): RawRun<T>;
  rawSQLTransaction<T = Record<string, unknown>>(
    queries: Query[],
  ): TransactionRun<T>;
}

export async function rows<T>(db: Db, query: Query): Promise<T[]> {
  return (await db.rawSQL<T>(query).run()) ?? [];
}

export async function first<T>(db: Db, query: Query): Promise<T | null> {
  return (await rows<T>(db, query))[0] ?? null;
}

export async function transaction<T>(db: Db, queries: Query[]): Promise<T[][]> {
  return (await db.rawSQLTransaction<T>(queries).run()) ?? [];
}

export async function changed(db: Db, query: Query): Promise<number> {
  if (!/\bRETURNING\b/iu.test(query.q)) {
    throw new Error("changed() requires a mutation with RETURNING");
  }
  return (await rows(db, query)).length;
}
