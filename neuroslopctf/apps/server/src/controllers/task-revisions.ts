import { action, query, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { taskRevision } from "../models/task-revision.js";
import { revisionDto } from "../services/dto.js";
import { loadCompetition, notFound, requireUser, type Ctx } from "../services/http.js";
import { loadTask, requireTaskPermission } from "../services/tasks.js";

export class TaskRevisionController {
  @action("GET", "/competitions/:cid/tasks/:tslug/revisions", { scope: "tasks:read" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    requireTaskPermission(tc, "task.view_secrets");
    const revisions = await orm.fetchAll(
      query().select(taskRevision)
        .where((r) => r.taskId.value().equals(value(tc.task.id)))
        .orderBy((r) => r.revision.value(), "desc"),
    );
    return { items: revisions.map(revisionDto) };
  }

  @action("GET", "/competitions/:cid/tasks/:tslug/revisions/:n", { scope: "tasks:read" })
  async show(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    requireTaskPermission(tc, "task.view_secrets");
    const n = Number(ctx.params.n);
    const found = Number.isSafeInteger(n) && n > 0 ? await orm.fetch(
      query().select(taskRevision).where((r) => r.taskId.value().equals(value(tc.task.id))
        .and(r.revision.value().equals(value(n)))),
    ) : null;
    if (!found) throw notFound("Revision");
    return revisionDto(found);
  }
}
