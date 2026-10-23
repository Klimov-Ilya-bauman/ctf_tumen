import { action, HttpError, query, t, value, type Orm } from "@backend/thingamajig";
import { orm, type User } from "../app.js";
import { task, type Task } from "../models/task.js";
import { taskRevision } from "../models/task-revision.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import {
  loadCompetition,
  pageQuery,
  paginate,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { slugify } from "../services/slug.js";
import { attachmentKeys, deleteFiles } from "../services/storage.js";
import { lit } from "../services/sql.js";
import {
  loadTask,
  managedTask,
  publicTask,
  requireTaskPermission,
  taskSummaries,
} from "../services/tasks.js";
import { escapeLike } from "./competitions.js";

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const DEFAULT_POINTS = { easy: 100, medium: 250, hard: 500 };

const taskFields = {
  title: t.string({ min: 3, max: 120 }),
  description: t.string({ min: 10, max: 8000 }),
  category: t.string({ min: 1, max: 40 }),
  difficulty: t.literal(DIFFICULTIES),
  base_points: t.int({ min: 0, max: 100000 }).optional(),
  answer_flag: t.string({ min: 1, max: 512 }),
  reward_token: t.string({ min: 1, max: 1024 }),
  release_at: t.datetime().nullable().optional(),
  max_solves: t.int({ min: 1 }).nullable().optional(),
};

const createBody = t.object(taskFields);
const updateBody = t.object(taskFields).partial();

const listQuery = pageQuery.extend({
  state: t
    .literal(["draft", "review", "published", "hidden", "archived"])
    .optional(),
  category: t.string({ max: 40 }).optional(),
  difficulty: t.literal(DIFFICULTIES).optional(),
  q: t.string({ max: 200 }).optional(),
});

const stateBody = t.object({
  action: t.literal([
    "submit",
    "approve",
    "reject",
    "publish",
    "hide",
    "archive",
  ]),
  comment: t.string({ max: 2000 }).optional(),
});

const TRANSITIONS = {
  submit: ["task.edit", ["draft"], "review"],
  approve: ["task.review", ["review"], "published"],
  reject: ["task.review", ["review"], "draft"],
  publish: ["task.publish", ["hidden"], "published"],
  hide: ["task.publish", ["published"], "hidden"],
  archive: ["task.publish", ["published", "hidden"], "archived"],
} as const;

const LOCKED_AFTER_SOLVE = ["answerFlag", "rewardToken", "basePoints"] as const;

export class TaskController {
  @action("GET", "/competitions/:cid/tasks", { scope: "tasks:read" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(task)
      .where((t) => t.competitionId.value().equals(value(id)))
      .orderBy((t) => t.category.value())
      .orderBy((t) => t.basePoints.value())
      .orderBy((t) => t.id.value());

    if (filters.state) {
      const state = filters.state;
      select.where((t) => t.state.value().equals(value(state)));
    }

    if (filters.category) {
      const category = filters.category;
      select.where((t) => t.category.value().equals(value(category)));
    }

    if (filters.difficulty) {
      const difficulty = filters.difficulty;
      select.where((t) => t.difficulty.value().equals(value(difficulty)));
    }

    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      select.where((t) => t.title.value().ilike(value(pattern)));
    }

    return paginate(select, filters, (rows) => taskSummaries(cc, rows));
  }

  @action("POST", "/competitions/:cid/tasks", { scope: "tasks:write" })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const body = camelKeys(await ctx.validBody(createBody));
    const [created] = await orm.execute(
      query().insert(task, {
        ...body,
        basePoints: body.basePoints ?? DEFAULT_POINTS[body.difficulty],
        releaseAt: body.releaseAt ?? null,
        maxSolves: body.maxSolves ?? null,
        competitionId: cc.competition.id,
        slug: slugify(body.title),
        authorId: actor.id,
        state: "draft",
        revision: 1,
      }),
    );

    await saveRevision(orm, created!, actor);

    await audit(
      cc.competition.id,
      actor,
      "task.created",
      {
        type: "task",
        id: created!.id,
      },
      { slug: created!.slug, title: created!.title },
    );

    ctx.response.status = 201;
    return managedTask(cc, await loadTask(cc, created!.slug));
  }

  @action("GET", "/competitions/:cid/tasks/:tslug", { scope: "tasks:read" })
  async show(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    return publicTask(cc, await loadTask(cc, ctx.params.tslug ?? ""));
  }

  @action("GET", "/competitions/:cid/tasks/:tslug/manage", {
    scope: "tasks:read",
  })
  async manage(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    requireTaskPermission(tc, "task.view_secrets");

    return managedTask(cc, tc);
  }

  @action("PATCH", "/competitions/:cid/tasks/:tslug", { scope: "tasks:write" })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    requireTaskPermission(tc, "task.edit");

    const body = camelKeys(await ctx.validBody(updateBody));
    const current = tc.task;
    const solved = (await solveCount(current.id)) > 0;
    const changed = (Object.keys(body) as (keyof typeof body)[]).filter(
      (key) => !sameValue(body[key], current[key]),
    );

    if (
      solved &&
      changed.some((key) =>
        (LOCKED_AFTER_SOLVE as readonly string[]).includes(key),
      )
    ) {
      throw new HttpError(
        409,
        "Secrets and points can't change after the first solve",
        "locked_after_solve",
      );
    }

    if (changed.length > 0) {
      const [updated] = await orm.execute(
        query()
          .update(task, {
            ...body,
            ...(solved ? {} : { revision: current.revision + 1 }),
            updatedAt: new Date(),
          })
          .where((t) => t.id.value().equals(value(current.id))),
      );

      if (!solved) {
        await saveRevision(orm, updated!, actor);
      }

      await audit(
        cc.competition.id,
        actor,
        "task.updated",
        {
          type: "task",
          id: current.id,
        },
        { fields: changed },
      );
    }

    return managedTask(cc, await loadTask(cc, current.slug));
  }

  @action("DELETE", "/competitions/:cid/tasks/:tslug", { scope: "tasks:write" })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    if ((await solveCount(tc.task.id)) > 0) {
      throw new HttpError(
        409,
        "A task with solves can't be deleted",
        "task_has_solves",
      );
    }

    const files = await attachmentKeys({ taskId: tc.task.id });

    await orm.execute(
      query()
        .delete(task)
        .where((t) => t.id.value().equals(value(tc.task.id))),
    );
    await deleteFiles(files);

    await audit(
      cc.competition.id,
      actor,
      "task.deleted",
      {
        type: "task",
        id: tc.task.id,
      },
      { slug: tc.task.slug },
    );
  }

  @action("POST", "/competitions/:cid/tasks/:tslug/state", {
    scope: "tasks:write",
  })
  async changeState(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    const { action: name, comment } = await ctx.validBody(stateBody);
    const [permission, from, to] = TRANSITIONS[name];

    requireTaskPermission(tc, permission);

    if (!(from as readonly string[]).includes(tc.task.state)) {
      throw new HttpError(
        409,
        `Can't ${name} a task in state ${tc.task.state}`,
        "invalid_transition",
      );
    }

    await orm.execute(
      query()
        .update(task, { state: to, updatedAt: new Date() })
        .where((t) => t.id.value().equals(value(tc.task.id))),
    );

    await audit(
      cc.competition.id,
      actor,
      to === "published" ? "task.published" : `task.${name}`,
      {
        type: "task",
        id: tc.task.id,
      },
      { from: tc.task.state, to, ...(comment ? { comment } : {}) },
    );

    return managedTask(cc, await loadTask(cc, tc.task.slug));
  }
}

async function saveRevision(tx: Orm<User>, row: Task, actor: User) {
  await tx.execute(
    query().insert(taskRevision, {
      taskId: row.id,
      revision: row.revision,
      title: row.title,
      description: row.description,
      category: row.category,
      difficulty: row.difficulty,
      basePoints: row.basePoints,
      answerFlag: row.answerFlag,
      rewardToken: row.rewardToken,
      releaseAt: row.releaseAt,
      createdBy: actor.id,
    }),
  );
}

async function solveCount(taskId: number): Promise<number> {
  const [row] = await orm.raw<{ count: string }>(
    `SELECT COUNT(*) AS "count" FROM "solve" WHERE "taskId" = ${lit(taskId)}`,
  );

  return Number(row?.count ?? 0);
}

function sameValue(next: unknown, current: unknown): boolean {
  if (next instanceof Date || current instanceof Date) {
    return (
      next instanceof Date &&
      current instanceof Date &&
      next.getTime() === current.getTime()
    );
  }

  return next === current;
}
