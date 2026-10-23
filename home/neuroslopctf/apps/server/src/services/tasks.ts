import { HttpError, query, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { hint, type Hint } from "../models/hint.js";
import { task as taskModel, type Task } from "../models/task.js";
import { attachment } from "../models/attachment.js";
import { attachmentDto, taskBase } from "./dto.js";
import { notFound, type CompetitionContext } from "./http.js";
import { isPlayable, isStaffRole, taskPermissions } from "./permissions.js";
import { solveCounts, taskPoints } from "./scoring.js";
import { lit } from "./sql.js";

export type TaskContext = {
  task: Task;
  permissions: string[];
};

export async function loadTask(
  cc: CompetitionContext,
  slug: string,
): Promise<TaskContext> {
  const competitionId = cc.competition.id;
  const found = await orm.fetch(
    query()
      .select(taskModel)
      .where((t) =>
        t.competitionId
          .value()
          .equals(value(competitionId))
          .and(t.slug.value().equals(value(slug))),
      ),
  );

  if (!found) {
    throw notFound("Task");
  }

  return withPermissions(cc, found);
}

export async function taskById(
  cc: CompetitionContext,
  taskId: number,
): Promise<TaskContext> {
  const competitionId = cc.competition.id;
  const found = await orm.fetch(
    query()
      .select(taskModel)
      .where((t) =>
        t.id
          .value()
          .equals(value(taskId))
          .and(t.competitionId.value().equals(value(competitionId))),
      ),
  );

  if (!found) {
    throw notFound("Task");
  }

  return withPermissions(cc, found);
}

async function withPermissions(
  cc: CompetitionContext,
  found: Task,
): Promise<TaskContext> {
  const grants = await grantsOf(cc, [found.id]);

  return {
    task: found,
    permissions: taskPermissions(
      cc.competition,
      cc.membership,
      cc.user,
      found,
      grants.get(found.id) ?? null,
    ),
  };
}

export function requireTaskPermission(
  tc: TaskContext,
  permission: string,
  message = "You don't have permission to do this with this task",
) {
  if (!tc.permissions.includes(permission)) {
    throw new HttpError(403, message, "forbidden");
  }
}

async function grantsOf(cc: CompetitionContext, taskIds: number[]) {
  if (!cc.user || taskIds.length === 0) {
    return new Map<number, "view" | "edit" | "manage">();
  }

  const rows = await orm.raw<{
    taskId: number;
    permission: "view" | "edit" | "manage";
  }>(`
    SELECT "taskId", "permission" FROM "task_grant"
    WHERE "userId" = ${lit(cc.user.id)}
      AND "taskId" IN (${taskIds.map((id) => lit(id)).join(", ")})`);

  return new Map(rows.map((row) => [row.taskId, row.permission]));
}

async function solvedBy(cc: CompetitionContext): Promise<Set<number>> {
  if (!cc.user) {
    return new Set();
  }

  const teamId = cc.competition.teamMode ? cc.membership?.teamId : null;
  const owner = teamId
    ? `("userId" = ${lit(cc.user.id)} OR "teamId" = ${lit(teamId)})`
    : `"userId" = ${lit(cc.user.id)}`;
  const rows = await orm.raw<{ taskId: number }>(
    `SELECT DISTINCT "taskId" FROM "solve" WHERE "competitionId" = ${lit(cc.competition.id)} AND ${owner}`,
  );

  return new Set(rows.map((row) => row.taskId));
}

export async function taskSummaries(cc: CompetitionContext, tasks: Task[]) {
  const [counts, solved, grants, authors] = await Promise.all([
    solveCounts(cc.competition.id),
    solvedBy(cc),
    grantsOf(
      cc,
      tasks.map((t) => t.id),
    ),
    authorsOf(tasks),
  ]);
  const staff = isStaffRole(cc.role);

  return tasks.map((t) => {
    const solveCount = counts.get(t.id) ?? 0;

    return {
      ...taskBase(t),
      points: taskPoints(cc.competition, t, solveCount),
      solve_count: solveCount,
      has_solved: solved.has(t.id),
      ...(staff
        ? {
            state: t.state,
            release_at: t.releaseAt,
            author: authors.get(t.authorId) ?? {
              id: t.authorId,
              username: "",
            },
          }
        : {}),
      viewer_permissions: taskPermissions(
        cc.competition,
        cc.membership,
        cc.user,
        t,
        grants.get(t.id) ?? null,
      ),
    };
  });
}

async function authorsOf(tasks: Task[]) {
  const ids = [...new Set(tasks.map((t) => t.authorId))];

  if (ids.length === 0) {
    return new Map<number, { id: number; username: string }>();
  }

  const rows = await orm.raw<{ id: number; username: string }>(
    `SELECT "id", "username" FROM "user" WHERE "id" IN (${ids.map((id) => lit(id)).join(", ")})`,
  );

  return new Map(rows.map((row) => [row.id, row]));
}

export function isClosed(
  cc: CompetitionContext,
  t: Task,
  solveCount: number,
): boolean {
  return (
    !isPlayable(cc.competition) ||
    (t.maxSolves !== null && solveCount >= t.maxSolves)
  );
}

export async function publicTask(cc: CompetitionContext, tc: TaskContext) {
  const [summary] = await taskSummaries(cc, [tc.task]);
  const taskId = tc.task.id;
  const attachments = await orm.fetchAll(
    query()
      .select(attachment)
      .where((a) => a.taskId.value().equals(value(taskId)))
      .orderBy((a) => a.id.value()),
  );

  return {
    ...summary!,
    description: tc.task.description,
    attachments: attachments.map(attachmentDto),
    hints: await hintViews(cc, tc),
    max_solves: tc.task.maxSolves,
    closed: isClosed(cc, tc.task, summary!.solve_count),
  };
}

export async function managedTask(cc: CompetitionContext, tc: TaskContext) {
  const base = await publicTask(cc, tc);
  const [counts] = await orm.raw<{ grants: string; submissions: string }>(`
    SELECT
      (SELECT COUNT(*) FROM "task_grant" WHERE "taskId" = ${lit(tc.task.id)}) AS "grants",
      (SELECT COUNT(*) FROM "submission" WHERE "taskId" = ${lit(tc.task.id)}) AS "submissions"`);

  return {
    ...base,
    answer_flag: tc.task.answerFlag,
    reward_token: tc.task.rewardToken,
    revision: tc.task.revision,
    base_points: tc.task.basePoints,
    grants_count: Number(counts?.grants ?? 0),
    submissions_count: Number(counts?.submissions ?? 0),
    can_edit_secrets:
      tc.permissions.includes("task.edit") && base.solve_count === 0,
  };
}

export async function hintViews(cc: CompetitionContext, tc: TaskContext) {
  const taskId = tc.task.id;
  const hints = await orm.fetchAll(
    query()
      .select(hint)
      .where((h) => h.taskId.value().equals(value(taskId)))
      .orderBy((h) => h.order.value())
      .orderBy((h) => h.id.value()),
  );
  const unlocked = await unlockedHints(cc, hints);

  return hints.map((h) => hintView(h, tc, unlocked.has(h.id)));
}

export function hintView(h: Hint, tc: TaskContext, unlocked: boolean) {
  const reveal = unlocked || tc.permissions.includes("task.view_secrets");

  return {
    id: h.id,
    order: h.order,
    cost: h.cost,
    unlocked,
    ...(reveal ? { body: h.body } : {}),
  };
}

async function unlockedHints(cc: CompetitionContext, hints: Hint[]) {
  if (!cc.user || hints.length === 0) {
    return new Set<number>();
  }

  const teamId = cc.competition.teamMode ? cc.membership?.teamId : null;
  const owner = teamId
    ? `("userId" = ${lit(cc.user.id)} OR "teamId" = ${lit(teamId)})`
    : `"userId" = ${lit(cc.user.id)}`;
  const rows = await orm.raw<{ hintId: number }>(`
    SELECT DISTINCT "hintId" FROM "hint_unlock"
    WHERE "hintId" IN (${hints.map((h) => lit(h.id)).join(", ")}) AND ${owner}`);

  return new Set(rows.map((row) => row.hintId));
}

export function hintDto(h: Hint) {
  return {
    id: h.id,
    task_id: h.taskId,
    order: h.order,
    body: h.body,
    cost: h.cost,
  };
}
