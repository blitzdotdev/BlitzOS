import { describe, expect, it } from "vitest";
import {
  changed,
  first,
  rows,
  transaction,
  type Db,
  type Query,
} from "../core/db.js";

class FakeDb implements Db {
  readonly queries: Query[] = [];
  readonly transactions: Query[][] = [];

  rawSQL<T>(query: Query) {
    this.queries.push(query);
    return {
      async run(): Promise<T[] | null> {
        return [{ id: "row" } as T];
      },
    };
  }

  rawSQLTransaction<T>(queries: Query[]) {
    this.transactions.push(queries);
    return {
      async run(): Promise<T[][] | null> {
        return queries.map((_query, index) => [{ index } as T]);
      },
    };
  }
}

describe("teenybase raw database contract", () => {
  it("preserves {q,v}, transaction, and RETURNING result semantics", async () => {
    const db = new FakeDb();
    const query = { q: "SELECT ?1 AS id", v: ["row"] };
    expect(await rows<{ id: string }>(db, query)).toEqual([{ id: "row" }]);
    expect(await first<{ id: string }>(db, query)).toEqual({ id: "row" });
    expect(db.queries).toEqual([query, query]);

    const queries = [
      { q: "INSERT INTO x VALUES (?1)", v: [1] },
      { q: "UPDATE x SET value = ?1", v: [2] },
    ];
    expect(await transaction<{ index: number }>(db, queries)).toEqual([
      [{ index: 0 }],
      [{ index: 1 }],
    ]);
    expect(db.transactions).toEqual([queries]);

    expect(
      await changed(db, { q: "UPDATE x SET value = ?1 RETURNING id", v: [2] }),
    ).toBe(1);
    await expect(
      changed(db, { q: "UPDATE x SET value = ?1", v: [2] }),
    ).rejects.toThrow("requires a mutation with RETURNING");
  });
});
