import pg from "pg";
import { ConflictError, ConstraintError, type SqlDriver } from "./engine.js";
import type { ObjectLike } from "./clockwork.js";

export class PgDriver implements SqlDriver {
  constructor(private client: pg.Pool | pg.PoolClient) {}

  static connect(config: string | pg.PoolConfig): PgDriver {
    return new PgDriver(
      new pg.Pool(
        typeof config === "string" ? { connectionString: config } : config,
      ),
    );
  }

  async query<TRow extends ObjectLike>(sql: string): Promise<TRow[]> {
    let result: pg.QueryResult<TRow> | pg.QueryResult<TRow>[];

    try {
      result = await this.client.query<TRow>(sql);
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

    try {
      await client.query("BEGIN");
      const result = await callback(new PgDriver(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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
      return new ConflictError(error.detail ?? error.message, error.constraint);
    case "23514":
    case "23502":
    case "22P02":
    case "22001":
    case "22007":
    case "22008":
      return new ConstraintError(error.detail ?? error.message, error.constraint);
    default:
      return error;
  }
}
