import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { orm } from "../app.js";
import { randomToken } from "../auth/secrets.js";
import { lit } from "./sql.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "data");
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

export async function saveFile(content: Buffer): Promise<string> {
  const key = randomToken(24);

  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  await writeFile(join(ATTACHMENTS_DIR, key), content);

  return key;
}

export function openFile(key: string): Readable {
  return createReadStream(join(ATTACHMENTS_DIR, safeKey(key)));
}

export async function deleteFile(key: string) {
  await rm(join(ATTACHMENTS_DIR, safeKey(key)), { force: true });
}

export async function attachmentKeys(
  target: { taskId: number } | { competitionId: number },
): Promise<string[]> {
  const where =
    "taskId" in target
      ? `a."taskId" = ${lit(target.taskId)}`
      : `t."competitionId" = ${lit(target.competitionId)}`;
  const rows = await orm.raw<{ storageKey: string }>(`
    SELECT a."storageKey" FROM "attachment" a
    JOIN "task" t ON t."id" = a."taskId"
    WHERE ${where}`);

  return rows.map((row) => row.storageKey);
}

export async function deleteFiles(keys: string[]) {
  await Promise.all(keys.map((key) => deleteFile(key)));
}

function safeKey(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("Invalid storage key");
  }

  return key;
}
