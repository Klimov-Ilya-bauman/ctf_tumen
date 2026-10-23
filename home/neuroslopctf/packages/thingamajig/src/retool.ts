import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlDriver } from "./engine.js";

export async function migrate(
  driver: SqlDriver,
  directory: string,
): Promise<string[]> {
  await driver.query(`
    CREATE TABLE IF NOT EXISTS "schema_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (
      await driver.query<{ name: string }>(
        `SELECT "name" FROM "schema_migrations"`,
      )
    ).map((row) => row.name),
  );

  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const pending = files.filter((file) => !applied.has(file));

  for (const file of pending) {
    const sql = await readFile(join(directory, file), "utf8");

    await driver.transaction(async (transaction) => {
      await transaction.query(sql);
      await transaction.query(
        `INSERT INTO "schema_migrations" ("name") VALUES ('${file.replaceAll("'", "''")}')`,
      );
    });
  }

  return pending;
}
