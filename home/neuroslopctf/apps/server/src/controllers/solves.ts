import { action, HttpError } from "@backend/thingamajig";
import { orm } from "../app.js";
import {
  loadCompetition,
  pageQuery,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { lit } from "../services/sql.js";

type SolveRow = {
  competition_slug: string;
  competition_title: string;
  task_slug: string;
  task_title: string;
  difficulty: string;
  rewardToken: string;
  pointsAwarded: number;
  solvedAt: Date;
  teamId: number | null;
  team_name: string | null;
  total?: string;
};

function solvesSql(
  userId: number,
  extraWhere: string,
  page?: { limit: number; offset: number },
) {
  return `
    SELECT c."slug" AS "competition_slug", c."title" AS "competition_title",
      t."slug" AS "task_slug", t."title" AS "task_title", t."difficulty",
      t."rewardToken", s."pointsAwarded", s."solvedAt",
      s."teamId", tm."name" AS "team_name", COUNT(*) OVER () AS "total"
    FROM "solve" s
    JOIN "task" t ON t."id" = s."taskId"
    JOIN "competition" c ON c."id" = s."competitionId"
    LEFT JOIN "team" tm ON tm."id" = s."teamId"
    WHERE (s."userId" = ${lit(userId)} OR s."teamId" IN (
      SELECT "teamId" FROM "membership" WHERE "userId" = ${lit(userId)} AND "teamId" IS NOT NULL
    )) ${extraWhere}
    ORDER BY s."solvedAt" DESC, s."id" DESC
    ${page ? `LIMIT ${lit(page.limit)} OFFSET ${lit(page.offset)}` : ""}`;
}

function solveRecord(row: SolveRow) {
  return {
    competition: { slug: row.competition_slug, title: row.competition_title },
    task: {
      slug: row.task_slug,
      title: row.task_title,
      difficulty: row.difficulty,
    },
    reward_token: row.rewardToken,
    points_awarded: row.pointsAwarded,
    solved_at: row.solvedAt,
    ...(row.teamId !== null
      ? { team: { id: row.teamId, name: row.team_name ?? "" } }
      : {}),
  };
}

export class SolveController {
  @action("GET", "/competitions/:cid/solves/mine", {
    scope: "competitions:read",
  })
  async competitionSolves(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const user = requireUser(ctx);

    if (!cc.membership) {
      throw new HttpError(
        403,
        "You are not a member of this competition",
        "not_member",
      );
    }

    const rows = await orm.raw<SolveRow>(
      solvesSql(user.id, `AND s."competitionId" = ${lit(cc.competition.id)}`),
    );

    return { items: rows.map(solveRecord) };
  }

  @action("GET", "/solves/mine", { scope: "competitions:read" })
  async mine(ctx: Ctx) {
    const user = requireUser(ctx);
    const page = ctx.validQuery(pageQuery);
    const rows = await orm.raw<SolveRow>(solvesSql(user.id, "", page));

    return {
      items: rows.map(solveRecord),
      total: rows[0] ? Number(rows[0].total) : await countMine(user.id),
      ...page,
    };
  }
}

async function countMine(userId: number): Promise<number> {
  const [row] = await orm.raw<{ count: string }>(
    `SELECT COUNT(*) AS "count" FROM (${solvesSql(userId, "")}) solves`,
  );

  return Number(row?.count ?? 0);
}
