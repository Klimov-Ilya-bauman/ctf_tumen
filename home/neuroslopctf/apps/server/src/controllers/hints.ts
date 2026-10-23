import {
  action,
  ConflictError,
  HttpError,
  query,
  t,
  value,
} from "@backend/thingamajig";
import { orm } from "../app.js";
import { hint } from "../models/hint.js";
import { hintUnlock } from "../models/hint-unlock.js";
import { audit } from "../services/audit.js";
import { lit } from "../services/sql.js";
import {
  loadCompetition,
  notFound,
  requireUser,
  type CompetitionContext,
  type Ctx,
} from "../services/http.js";
import {
  hintDto,
  hintView,
  hintViews,
  loadTask,
  taskById,
} from "../services/tasks.js";
import { task as taskModel } from "../models/task.js";

const hintFields = {
  body: t.string({ min: 1, max: 8000 }),
  cost: t.int({ min: 0, max: 100000 }),
  order: t.int({ min: 1, max: 1000 }).optional(),
};

const createBody = t.object(hintFields);
const updateBody = t.object(hintFields).partial();

export class HintController {
  @action("GET", "/competitions/:cid/tasks/:tslug/hints", {
    scope: "tasks:read",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    return { items: await hintViews(cc, tc) };
  }

  @action("POST", "/competitions/:cid/tasks/:tslug/hints", {
    scope: "tasks:write",
  })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const body = await ctx.validBody(createBody);
    const [last] = await orm.raw<{ max: number | null }>(
      `SELECT MAX("order") AS "max" FROM "hint" WHERE "taskId" = ${lit(tc.task.id)}`,
    );
    const [created] = await orm.execute(
      query().insert(hint, {
        taskId: tc.task.id,
        body: body.body,
        cost: body.cost,
        order: body.order ?? (last?.max ?? 0) + 1,
      }),
    );

    await audit(
      cc.competition.id,
      actor,
      "hint.created",
      {
        type: "hint",
        id: created!.id,
      },
      { task_id: tc.task.id, cost: body.cost },
    );

    ctx.response.status = 201;
    return hintDto(created!);
  }

  @action("PATCH", "/competitions/:cid/hints/:hid", { scope: "tasks:write" })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const found = await findHint(cc, ctx.params.hid);

    const body = await ctx.validBody(updateBody);
    const [updated] = await orm.execute(
      query()
        .update(hint, body)
        .where((h) => h.id.value().equals(value(found.id))),
    );

    return hintDto(updated ?? found);
  }

  @action("DELETE", "/competitions/:cid/hints/:hid", { scope: "tasks:write" })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const found = await findHint(cc, ctx.params.hid);

    await orm.execute(
      query()
        .delete(hint)
        .where((h) => h.id.value().equals(value(found.id))),
    );
  }

  @action("POST", "/competitions/:cid/hints/:hid/unlock", { scope: "submit" })
  async unlock(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const user = requireUser(ctx);

    const found = await findHint(cc, ctx.params.hid);
    const teamId = cc.membership?.teamId ?? null;

    if (
      cc.competition.teamMode &&
      teamId === null &&
      cc.membership?.role === "participant"
    ) {
      throw new HttpError(409, "Join a team first", "team_required");
    }

    try {
      await orm.execute(
        query().insert(hintUnlock, {
          hintId: found.id,
          userId: user.id,
          teamId: cc.competition.teamMode ? teamId : null,
          competitionId: cc.competition.id,
          cost: found.cost,
        }),
      );
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }
    }

    return hintView(found, await taskById(cc, found.taskId), true);
  }
}

async function findHint(cc: CompetitionContext, hid: string | undefined) {
  const id = Number(hid);
  const competitionId = cc.competition.id;
  const found = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(hint)
          .where((h) =>
            h.id
              .value()
              .equals(value(id))
              .and(
                h
                  .subselect(taskModel)
                  .where((t) =>
                    t.id
                      .value()
                      .equals(h.taskId.value())
                      .and(
                        t.competitionId.value().equals(value(competitionId)),
                      ),
                  )
                  .exists(),
              ),
          ),
      )
    : null;

  if (!found) {
    throw notFound("Hint");
  }

  return found;
}
