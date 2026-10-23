import pg from "pg";
import { ConflictError, ConstraintError, type SqlDriver } from "./engine.js";
import type { ObjectLike } from "./clockwork.js";

export class PgDriver implements SqlDriver {
  constructor(private client: pg.Pool | pg.PoolClient) {}

  static connect(config: string | pg.PoolConfig): PgDriver {
    const pool = new pg.Pool(typeof config === "string" ? { connectionString: config } : config);
    // PostgreSQL can terminate idle connections; EventEmitter 'error' must not
    // become an unhandled process exception.
    pool.on("error", (error) => console.error("Idle database connection failed", error.message));
    return new PgDriver(pool);
  }

  async query<TRow extends ObjectLike>(sql: string, parameters?: unknown[]): Promise<TRow[]> {
    let result: pg.QueryResult<TRow> | pg.QueryResult<TRow>[];

    try {
      result = await this.client.query<TRow>(sql, parameters);
    } catch (error) {
      throw translateError(error);
    }

    return Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows;
  }

  async transaction<TResult>(
    callback: (driver: SqlDriver) => Promise<TResult>,
  ): Promise<TResult> {
    if (!(this.client instanceof pg.Pool)) {
      const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
      await this.client.query(`SAVEPOINT ${savepoint}`);

      try {
        const result = await callback(this);
        await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const client = await this.client.connect();
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      const result = await callback(new PgDriver(client));
      if (connectionError) throw connectionError;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* The connection may be gone. */ }
      throw error;
    } finally {
      client.release(connectionError);
      client.off("error", onError);
    }
  }

  async close(): Promise<void> {
    if (this.client instanceof pg.Pool) {
      await this.client.end();
    }
  }
}

function translateError(error: unknown): unknown {
  if (!(error instanceof pg.DatabaseError)) {
    return error;
  }

  switch (error.code) {
    case "23505":
    case "23P01":
    case "23503":
      return new ConflictError("Conflicting record", error.constraint);
    case "23514":
    case "23502":
    case "22P02":
    case "22001":
    case "22003":
    case "22021":
    case "22023":
    case "22007":
    case "22008":
      return new ConstraintError("Invalid record", error.constraint);
    default:
      return error;
  }
}
