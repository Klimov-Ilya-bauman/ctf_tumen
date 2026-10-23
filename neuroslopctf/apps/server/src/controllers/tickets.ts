import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { ticket, type Ticket } from "../models/ticket.js";
import { ticketMessage } from "../models/ticket-message.js";
import { ticketDto, ticketMessageDto, viewerOf } from "../services/dto.js";
import {
  loadCompetition,
  notFound,
  pageQuery,
  paginate,
  requireUser,
  type CompetitionContext,
  type Ctx,
} from "../services/http.js";
import { activeRole, isStaffRole } from "../services/permissions.js";
import { lit } from "../services/sql.js";
import { loadTask } from "../services/tasks.js";
import { task as taskModel } from "../models/task.js";

const listQuery = pageQuery.extend({
  status: t.literal(["open", "answered", "closed"]).optional(),
  task: t.string({ max: 200 }).optional(),
});

const createBody = t.object({
  subject: t.string({ min: 1, max: 120 }),
  body: t.string({ min: 1, max: 8000 }),
  task_slug: t.string({ max: 200 }).optional(),
});

const updateBody = t.object({
  status: t.literal(["open", "answered", "closed"]).optional(),
  visibility: t.literal(["private", "public"]).optional(),
});

const messageBody = t.object({
  body: t.string({ min: 1, max: 8000 }),
  internal: t.boolean().default(false),
});

export class TicketController {
  @action("GET", "/competitions/:cid/tickets", { scope: "competitions:read" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(ticket)
      .where((tk) => tk.competitionId.value().equals(value(id)))
      .orderBy((tk) => tk.updatedAt.value(), "desc");

    if (filters.status) {
      const status = filters.status;
      select.where((tk) => tk.status.value().equals(value(status)));
    }

    if (filters.task) {
      const slug = filters.task;
      select.where((tk) =>
        tk
          .subselect(taskModel)
          .where((task) =>
            tk.taskId
              .value()
              .equals(task.id.value())
              .and(task.slug.value().equals(value(slug))),
          )
          .exists(),
      );
    }

    return paginate(select, filters, async (rows) =>
      Promise.all(
        rows.map(async (row) => ({
          ...ticketDto(row),
          viewer: viewerOf(cc.membership, await ticketPermissions(cc, row)),
        })),
      ),
    );
  }

  @action("POST", "/competitions/:cid/tickets", { scope: "tickets:write" })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const user = requireUser(ctx);

    const body = await ctx.validBody(createBody);
    const taskId = body.task_slug
      ? (await loadTask(cc, body.task_slug)).task.id
      : null;

    const [created] = await orm.execute(
      query().insert(ticket, {
        competitionId: cc.competition.id,
        taskId: taskId,
        openedBy: user.id,
        teamId: cc.competition.teamMode
          ? (cc.membership?.teamId ?? null)
          : null,
        subject: body.subject,
      }),
    );

    await orm.execute(
      query().insert(ticketMessage, {
        ticketId: created!.id,
        authorId: user.id,
        body: body.body,
        internal: false,
      }),
    );

    ctx.response.status = 201;
    return this.detail(cc, created!);
  }

  @action("GET", "/competitions/:cid/tickets/:id", {
    scope: "competitions:read",
  })
  async show(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    return this.detail(cc, await findTicket(cc, ctx.params.id));
  }

  @action("PATCH", "/competitions/:cid/tickets/:id", { scope: "tickets:write" })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const found = await findTicket(cc, ctx.params.id);
    await requireAnswerer(cc, found);

    const body = await ctx.validBody(updateBody);
    const [updated] = await orm.execute(
      query()
        .update(ticket, { ...body, updatedAt: new Date() })
        .where((tk) => tk.id.value().equals(value(found.id))),
    );

    return this.detail(cc, updated!);
  }

  @action("POST", "/competitions/:cid/tickets/:id/messages", {
    scope: "tickets:write",
  })
  async post(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const user = requireUser(ctx);

    const found = await findTicket(cc, ctx.params.id);
    const answerer = (await ticketPermissions(cc, found)).includes(
      "tickets.answer",
    );
    const ownSide =
      found.openedBy === user.id ||
      (found.teamId !== null && found.teamId === cc.membership?.teamId);

    const body = await ctx.validBody(messageBody);

    const status = body.internal
      ? found.status
      : answerer && !ownSide
        ? "answered"
        : "open";

    const [created] = await orm.execute(
      query().insert(ticketMessage, {
        ticketId: found.id,
        authorId: user.id,
        body: body.body,
        internal: body.internal,
      }),
    );

    await orm.execute(
      query()
        .update(ticket, { status, updatedAt: new Date() })
        .where((tk) => tk.id.value().equals(value(found.id))),
    );

    ctx.response.status = 201;
    return ticketMessageDto(created!);
  }

  private async detail(cc: CompetitionContext, row: Ticket) {
    const messages = await orm.fetchAll(
      query()
        .select(ticketMessage)
        .where((m) => m.ticketId.value().equals(value(row.id)))
        .orderBy((m) => m.createdAt.value())
        .orderBy((m) => m.id.value()),
    );

    return {
      ...ticketDto(row),
      messages: messages.map(ticketMessageDto),
      viewer: viewerOf(cc.membership, await ticketPermissions(cc, row)),
    };
  }
}

async function findTicket(cc: CompetitionContext, rawId: string | undefined) {
  const id = Number(rawId);
  const competitionId = cc.competition.id;
  const found = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(ticket)
          .where((tk) =>
            tk.id
              .value()
              .equals(value(id))
              .and(tk.competitionId.value().equals(value(competitionId))),
          ),
      )
    : null;

  if (!found) {
    throw notFound("Ticket");
  }

  return found;
}

async function ticketPermissions(
  cc: CompetitionContext,
  row: Ticket,
): Promise<string[]> {
  const role = activeRole(cc.membership);

  if (role === "owner" || role === "admin") {
    return ["tickets.view_all", "tickets.answer"];
  }

  if (!cc.user || !isStaffRole(role) || row.taskId === null) {
    return [];
  }

  const [owns] = await orm.raw<{ owns: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM "task" t WHERE t."id" = ${lit(row.taskId)} AND (
        t."authorId" = ${lit(cc.user.id)} OR EXISTS (
          SELECT 1 FROM "task_grant" g WHERE g."taskId" = t."id"
            AND g."userId" = ${lit(cc.user.id)} AND g."permission" = 'manage'
        )
      )
    ) AS "owns"`);

  return owns?.owns ? ["tickets.view_all", "tickets.answer"] : [];
}

async function requireAnswerer(cc: CompetitionContext, row: Ticket) {
  if (!(await ticketPermissions(cc, row)).includes("tickets.answer")) {
    throw new HttpError(403, "You can't manage this ticket", "forbidden");
  }
}
