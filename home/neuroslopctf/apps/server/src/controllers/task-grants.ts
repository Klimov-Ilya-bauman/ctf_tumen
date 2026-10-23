import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { taskGrant } from "../models/task-grant.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import { grantDto } from "../services/dto.js";
import {
  loadCompetition,
  membershipOf,
  notFound,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { activeRole, isStaffRole } from "../services/permissions.js";
import { loadTask } from "../services/tasks.js";

const LEVELS = ["view", "edit", "manage"] as const;

const createBody = t.object({
  user_id: t.int({ min: 1 }),
  permission: t.literal(LEVELS),
});

export class TaskGrantController {
  @action("GET", "/competitions/:cid/tasks/:tslug/grants", {
    scope: "tasks:read",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const grants = await orm.fetchAll(
      query()
        .select(taskGrant)
        .where((g) => g.taskId.value().equals(value(tc.task.id)))
        .orderBy((g) => g.createdAt.value()),
    );

    return { items: grants.map(grantDto) };
  }

  @action("POST", "/competitions/:cid/tasks/:tslug/grants", {
    scope: "tasks:write",
  })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const body = camelKeys(await ctx.validBody(createBody));
    const grantee = await membershipOf(cc.competition.id, body.userId);

    if (!grantee || !isStaffRole(activeRole(grantee))) {
      throw new HttpError(
        422,
        "Grants can only be given to staff of this competition",
        "grantee_not_staff",
      );
    }

    const taskId = tc.task.id;
    await orm.execute(
      query()
        .delete(taskGrant)
        .where((g) =>
          g.taskId
            .value()
            .equals(value(taskId))
            .and(g.userId.value().equals(value(body.userId))),
        ),
    );

    const [created] = await orm.execute(
      query().insert(taskGrant, {
        taskId: taskId,
        userId: body.userId,
        permission: body.permission,
        grantedBy: actor.id,
      }),
    );

    await audit(
      cc.competition.id,
      actor,
      "task_grant.created",
      {
        type: "task",
        id: taskId,
      },
      { user_id: body.userId, permission: body.permission },
    );

    ctx.response.status = 201;
    return grantDto(created!);
  }

  @action("DELETE", "/competitions/:cid/tasks/:tslug/grants/:uid", {
    scope: "tasks:write",
  })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const userId = Number(ctx.params.uid);
    const taskId = tc.task.id;
    const [removed] = Number.isInteger(userId)
      ? await orm.execute(
          query()
            .delete(taskGrant)
            .where((g) =>
              g.taskId
                .value()
                .equals(value(taskId))
                .and(g.userId.value().equals(value(userId))),
            ),
        )
      : [];

    if (!removed) {
      throw notFound("Grant");
    }

    await audit(
      cc.competition.id,
      actor,
      "task_grant.revoked",
      {
        type: "task",
        id: taskId,
      },
      { user_id: userId },
    );
  }
}
