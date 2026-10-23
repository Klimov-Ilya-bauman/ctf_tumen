import {
  action,
  ConflictError,
  HttpError,
  query,
  t,
  value,
} from "@backend/thingamajig";
import { orm } from "../app.js";
import { submission } from "../models/submission.js";
import { solve } from "../models/solve.js";
import { submissionDto } from "../services/dto.js";
import {
  loadCompetition,
  pageQuery,
  paginate,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { taskPoints } from "../services/scoring.js";
import { lit } from "../services/sql.js";
import { isClosed, loadTask } from "../services/tasks.js";
import { task as taskModel } from "../models/task.js";

const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60;

const listQuery = pageQuery.extend({
  task: t.string({ max: 200 }).optional(),
  user: t.int({ min: 1 }).optional(),
  team: t.int({ min: 1 }).optional(),
  correct: t.boolean().optional(),
});

export class SubmissionController {
  @action("POST", "/competitions/:cid/tasks/:tslug/submit", { scope: "submit" })
  async submit(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const user = requireUser(ctx);

    const { flag } = await ctx.validBody(
      t.object({ flag: t.string({ min: 1, max: 512 }) }),
    );
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    const task = tc.task;
    const teamId = cc.competition.teamMode
      ? (cc.membership?.teamId ?? null)
      : null;

    if (
      cc.competition.teamMode &&
      teamId === null &&
      cc.membership?.role === "participant"
    ) {
      throw new HttpError(409, "Join a team first", "team_required");
    }

    const [stats] = await orm.raw<{
      solves: string;
      recent: string;
      oldest_recent: Date | null;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM "solve" WHERE "taskId" = ${lit(task.id)}) AS "solves",
        COUNT(*) AS "recent", MIN("createdAt") AS "oldest_recent"
      FROM "submission"
      WHERE "taskId" = ${lit(task.id)} AND "userId" = ${lit(user.id)}
        AND "createdAt" > now() - interval '${RATE_WINDOW_SECONDS} seconds'`);
    const solveCount = Number(stats?.solves ?? 0);
    const owner =
      teamId !== null
        ? `"teamId" = ${lit(teamId)}`
        : `"userId" = ${lit(user.id)}`;
    const [previous] = await orm.raw<{
      pointsAwarded: number;
      solvedAt: Date;
    }>(
      `SELECT "pointsAwarded", "solvedAt" FROM "solve" WHERE "taskId" = ${lit(task.id)} AND ${owner}`,
    );

    if (!previous && isClosed(cc, task, solveCount)) {
      throw new HttpError(
        410,
        "This task is closed for new solves",
        "task_closed",
      );
    }

    if (Number(stats?.recent ?? 0) >= RATE_LIMIT) {
      const oldest = stats?.oldest_recent?.getTime() ?? Date.now();
      const retryAfter = Math.max(
        1,
        Math.ceil((oldest + RATE_WINDOW_SECONDS * 1000 - Date.now()) / 1000),
      );

      throw new HttpError(
        429,
        "Too many attempts, try again later",
        "rate_limited",
        {
          "retry-after": String(retryAfter),
        },
      );
    }

    const correct = flag === task.answerFlag;

    const [attempt] = await orm.execute(
      query().insert(submission, {
        competitionId: cc.competition.id,
        taskId: task.id,
        userId: user.id,
        teamId: teamId,
        value: flag,
        correct,
      }),
    );

    if (!correct) {
      return { correct: false, message: "Wrong flag" };
    }

    if (previous) {
      return solvedResult(task.rewardToken, previous, true);
    }

    const points = taskPoints(cc.competition, task, solveCount);

    try {
      const [created] = await orm.transaction((inner) =>
        inner.execute(
          query().insert(solve, {
            competitionId: cc.competition.id,
            taskId: task.id,
            userId: user.id,
            teamId: teamId,
            submissionId: attempt!.id,
            pointsAwarded: points,
          }),
        ),
      );

      return solvedResult(task.rewardToken, created!, false);
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }

      const [existing] = await orm.raw<{
        pointsAwarded: number;
        solvedAt: Date;
      }>(
        `SELECT "pointsAwarded", "solvedAt" FROM "solve" WHERE "taskId" = ${lit(task.id)} AND ${owner}`,
      );

      return solvedResult(task.rewardToken, existing!, true);
    }
  }

  @action("GET", "/competitions/:cid/submissions", {
    scope: "competitions:read",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(submission)
      .where((s) => s.competitionId.value().equals(value(id)))
      .orderBy((s) => s.createdAt.value(), "desc")
      .orderBy((s) => s.id.value(), "desc");

    if (filters.user) {
      const userId = filters.user;
      select.where((s) => s.userId.value().equals(value(userId)));
    }

    if (filters.team) {
      const teamId = filters.team;
      select.where((s) => s.teamId.value().equals(value(teamId)));
    }

    if (filters.correct !== undefined) {
      const correct = filters.correct;
      select.where((s) => s.correct.value().equals(value(correct)));
    }

    if (filters.task) {
      const slug = filters.task;
      select.where((s) =>
        s
          .subselect(taskModel)
          .where((t) =>
            t.id
              .value()
              .equals(s.taskId.value())
              .and(t.slug.value().equals(value(slug))),
          )
          .exists(),
      );
    }

    return paginate(select, filters, (rows) => rows.map(submissionDto));
  }
}

function solvedResult(
  rewardToken: string,
  solved: { pointsAwarded: number; solvedAt: Date },
  alreadySolved: boolean,
) {
  return {
    correct: true,
    already_solved: alreadySolved,
    reward_token: rewardToken,
    points: solved.pointsAwarded,
    solved_at: solved.solvedAt,
    message: alreadySolved ? "Correct, already solved" : "Correct flag",
  };
}
