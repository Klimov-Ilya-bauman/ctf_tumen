import { value, type ContextAccessor } from "@backend/thingamajig";
import { app } from "../app.js";
import { canAnswerTicket, canReadTicket } from "./access.js";
import { ticket } from "./ticket.js";

export class TicketMessage {
  id!: number;
  ticketId!: number;
  authorId!: number;
  body!: string;
  internal!: boolean;
  createdAt!: Date;
}

export const ticketMessage = app.define("ticket_message", TicketMessage, (d) =>
  d
    .inherit(ticket, (ctx) =>
      ctx.left.ticketId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) =>
        isPublicNote(ctx)
          .and(
            canReadTicket(
              ctx.roles,
              ctx
                .subselect(ticket)
                .where((t) =>
                  t.id
                    .value()
                    .equals(ctx.ticketId.value())
                    .and(t.visibility.value().equals(value("public"))),
                )
                .exists(),
            ),
          )
          .or(canAnswerTicket(ctx.roles)),
      create: (ctx) =>
        isPublicNote(ctx)
          .and(ctx.roles.opener.or(ctx.roles.teammate))
          .or(canAnswerTicket(ctx.roles)),
    }),
);

function isPublicNote(ctx: ContextAccessor<TicketMessage>) {
  return ctx.internal.value().equals(value(false));
}
