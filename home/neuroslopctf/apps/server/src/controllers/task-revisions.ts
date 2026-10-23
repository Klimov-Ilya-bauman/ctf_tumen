import { action, query, value } from "@backend/thingamajig";
import { orm, sudo } from "../app.js";
import { competition } from "../models/competition.js";
import { task as taskModel } from "../models/task.js";
import { taskRevision } from "../models/task-revision.js";
import { revisionDto } from "../services/dto.js";
import {
  loadCompetition,
  notFound,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { loadTask } from "../services/tasks.js";

export class TaskRevisionController {
  @action("GET", "/competitions/:cid/tasks/:tslug/revisions", {
    scope: "tasks:read",
  })
  async list(ctx: Ctx) {
    requireUser(ctx);
    const cid = ctx.params.cid ?? "";
    const slug = ctx.params.tslug ?? "";

    const revisions = await sudo(async () => {
      const comp = await orm.fetch(
        query()
          .select(competition)
          .where((c) =>
            /^\d+$/.test(cid)
              ? c.id.value().equals(value(Number(cid)))
              : c.slug.value().equals(value(cid)),
          ),
      );

      if (!comp) {
        return null;
      }

      const current = await orm.fetch(
        query()
          .select(taskModel)
          .where((t) =>
            t.competitionId
              .value()
              .equals(value(comp.id))
              .and(t.slug.value().equals(value(slug))),
          ),
      );

      if (!current) {
        return null;
      }

      return orm.fetchAll(
        query()
          .select(taskRevision)
          .where((r) => r.taskId.value().equals(value(current.id)))
          .orderBy((r) => r.revision.value(), "desc"),
      );
    });

    if (!revisions) {
      throw notFound("Task");
    }

    return { items: revisions.map(revisionDto) };
  }

  @action("GET", "/competitions/:cid/tasks/:tslug/revisions/:n", {
    scope: "tasks:read",
  })
  async show(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const n = Number(ctx.params.n);
    const found = Number.isInteger(n)
      ? await orm.fetch(
          query()
            .select(taskRevision)
            .where((r) =>
              r.taskId
                .value()
                .equals(value(tc.task.id))
                .and(r.revision.value().equals(value(n))),
            ),
        )
      : null;

    if (!found) {
      throw notFound("Revision");
    }

    return revisionDto(found);
  }
}
