import { orm } from "../app.js";
import type { Competition } from "../models/competition.js";
import type { Task } from "../models/task.js";
import { lit } from "./sql.js";

const DYNAMIC_DECAY_SOLVES = 20;
const DYNAMIC_MINIMUM = 0.25;

export function taskPoints(
  competition: Competition,
  task: Task,
  solveCount: number,
): number {
  if (competition.scoring === "static") {
    return task.basePoints;
  }

  const minimum = Math.ceil(task.basePoints * DYNAMIC_MINIMUM);
  const decayed = Math.round(
    task.basePoints -
      ((task.basePoints - minimum) * solveCount) / DYNAMIC_DECAY_SOLVES,
  );

  return Math.max(minimum, decayed);
}

export async function solveCounts(
  competitionId: number,
): Promise<Map<number, number>> {
  const rows = await orm.raw<{ taskId: number; count: string }>(
    `SELECT "taskId", COUNT(*) AS "count" FROM "solve" WHERE "competitionId" = ${lit(competitionId)} GROUP BY "taskId"`,
  );

  return new Map(rows.map((row) => [row.taskId, Number(row.count)]));
}

export type ScoreboardEntry = {
  rank: number;
  user_id?: number;
  team_id?: number;
  name: string;
  score: number;
  solved: number;
  last_solve_at: Date | null;
};

export async function scoreboard(
  competition: Competition,
  cutoff: Date | null,
  page: { limit: number; offset: number },
): Promise<{ items: ScoreboardEntry[]; total: number }> {
  const id = lit(competition.id);
  const solvedBefore = cutoff ? `AND "solvedAt" <= ${lit(cutoff)}` : "";
  const unlockedBefore = cutoff ? `AND "unlockedAt" <= ${lit(cutoff)}` : "";

  const ranked = competition.teamMode
    ? `
      SELECT t."id" AS "teamId", NULL::integer AS "userId", t."name",
        COALESCE(s."points", 0) - COALESCE(h."cost", 0) AS "score",
        COALESCE(s."solved", 0) AS "solved", s."last_solve_at", t."id" AS "key"
      FROM "team" t
      LEFT JOIN (
        SELECT "teamId", SUM("pointsAwarded") AS "points", COUNT(*) AS "solved",
          MAX("solvedAt") AS "last_solve_at"
        FROM "solve" WHERE "competitionId" = ${id} AND "teamId" IS NOT NULL ${solvedBefore}
        GROUP BY "teamId"
      ) s ON s."teamId" = t."id"
      LEFT JOIN (
        SELECT "teamId", SUM("cost") AS "cost"
        FROM "hint_unlock" WHERE "competitionId" = ${id} AND "teamId" IS NOT NULL ${unlockedBefore}
        GROUP BY "teamId"
      ) h ON h."teamId" = t."id"
      WHERE t."competitionId" = ${id}`
    : `
      SELECT NULL::integer AS "teamId", u."id" AS "userId", u."username" AS "name",
        COALESCE(s."points", 0) - COALESCE(h."cost", 0) AS "score",
        COALESCE(s."solved", 0) AS "solved", s."last_solve_at", u."id" AS "key"
      FROM "membership" m
      JOIN "user" u ON u."id" = m."userId"
      LEFT JOIN (
        SELECT "userId", SUM("pointsAwarded") AS "points", COUNT(*) AS "solved",
          MAX("solvedAt") AS "last_solve_at"
        FROM "solve" WHERE "competitionId" = ${id} ${solvedBefore}
        GROUP BY "userId"
      ) s ON s."userId" = m."userId"
      LEFT JOIN (
        SELECT "userId", SUM("cost") AS "cost"
        FROM "hint_unlock" WHERE "competitionId" = ${id} ${unlockedBefore}
        GROUP BY "userId"
      ) h ON h."userId" = m."userId"
      WHERE m."competitionId" = ${id} AND m."status" = 'active'
        AND (m."role" = 'participant' OR COALESCE(s."solved", 0) > 0)`;

  const rows = await orm.raw<{
    teamId: number | null;
    userId: number | null;
    name: string;
    score: string;
    solved: string;
    last_solve_at: Date | null;
    rank: string;
    total: string;
  }>(`
    SELECT *, COUNT(*) OVER () AS "total" FROM (
      SELECT *, ROW_NUMBER() OVER (
        ORDER BY "score" DESC, "last_solve_at" ASC NULLS LAST, "key" ASC
      ) AS "rank"
      FROM (${ranked}) entries
    ) ranked
    ORDER BY "rank"
    LIMIT ${lit(page.limit)} OFFSET ${lit(page.offset)}`);

  const total = rows[0] ? Number(rows[0].total) : await countEntries(ranked);

  return {
    total,
    items: rows.map((row) => ({
      rank: Number(row.rank),
      ...(row.teamId !== null
        ? { team_id: row.teamId }
        : { user_id: row.userId! }),
      name: row.name,
      score: Number(row.score),
      solved: Number(row.solved),
      last_solve_at: row.last_solve_at,
    })),
  };
}

async function countEntries(ranked: string): Promise<number> {
  const [row] = await orm.raw<{ count: string }>(
    `SELECT COUNT(*) AS "count" FROM (${ranked}) entries`,
  );

  return Number(row?.count ?? 0);
}

export async function scoreOf(
  competition: Competition,
  userId: number,
  teamId: number | null,
): Promise<number> {
  const [owner, key] =
    competition.teamMode && teamId !== null
      ? ["teamId", teamId]
      : ["userId", userId];
  const [row] = await orm.raw<{ score: string }>(`
    SELECT
      COALESCE((SELECT SUM("pointsAwarded") FROM "solve"
        WHERE "competitionId" = ${lit(competition.id)} AND "${owner}" = ${lit(key)}), 0)
      - COALESCE((SELECT SUM("cost") FROM "hint_unlock"
        WHERE "competitionId" = ${lit(competition.id)} AND "${owner}" = ${lit(key)}), 0)
      AS "score"`);

  return Number(row?.score ?? 0);
}
