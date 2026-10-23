import { action, query, t, value } from "@backend/thingamajig";
import { auditEvent } from "../models/audit-event.js";
import { auditDto } from "../services/dto.js";
import {
  loadCompetition,
  pageQuery,
  paginate,
  requireUser,
  type Ctx,
} from "../services/http.js";

const listQuery = pageQuery.extend({
  actor: t.int({ min: 1 }).optional(),
  action: t.string({ max: 100 }).optional(),
});

export class AuditController {
  @action("GET", "/competitions/:cid/audit", { scope: "competitions:read" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(auditEvent)
      .where((e) => e.competitionId.value().equals(value(id)))
      .orderBy((e) => e.createdAt.value(), "desc")
      .orderBy((e) => e.id.value(), "desc");

    if (filters.actor) {
      const actor = filters.actor;
      select.where((e) => e.actorId.value().equals(value(actor)));
    }

    if (filters.action) {
      const name = filters.action;
      select.where((e) => e.action.value().equals(value(name)));
    }

    return paginate(select, filters, (rows) => rows.map(auditDto));
  }
}
