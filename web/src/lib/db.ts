import { Pool } from "pg";

/**
 * Postgres access. Server-side only — importing this from a Client Component
 * would leak the connection string into the browser bundle.
 *
 * One pool per process, cached on globalThis so Next's dev server does not open
 * a new one on every hot reload.
 */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    // The sniffer may be mid-write; a page should fail fast rather than hang.
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
