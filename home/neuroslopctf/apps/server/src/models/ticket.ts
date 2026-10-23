import { value } from "@backend/thingamajig";
import { app } from "../app.js";
import { membership } from "./membership.js";
import { task } from "./task.js";
import { taskGrant } from "./task-grant.js";
import { canAnswerTicket, canReadTicket } from "./access.js";
import { competition } from "./competition.js";

export class Ticket {
  id!: number;
  competitionId!: number;
  taskId!: number | null;
  openedBy!: number;
  teamId!: number | null;
  subject!: string;
  status!: "open" | "answered" | "closed";
  visibility!: "private" | "public";
  createdAt!: Date;
  updatedAt!: Date;
}

export const ticket = app.define("ticket", Ticket, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .grant("opener", (ctx) =>
      ctx.openedBy.value().equals(ctx.user.id.value()),
    )
    .grant("teammate", (ctx) =>
      ctx.teamId
        .value()
        .isNull()
        .not()
        .and(
          ctx
            .subselect(membership)
            .where((m) =>
              m.competitionId
                .value()
                .equals(ctx.competitionId.value())
                .and(m.userId.value().equals(ctx.user.id.value()))
                .and(m.teamId.value().equals(ctx.teamId.value())),
            )
            .exists(),
        ),
    )
    .grant("handler", (ctx) =>
      ctx
        .subselect(task)
        .where((t) =>
          ctx.taskId
            .value()
            .equals(t.id.value())
            .and(
              t.authorId
                .value()
                .equals(ctx.user.id.value())
                .or(
                  t
                    .subselect(taskGrant)
                    .where((g) =>
                      g.taskId
                        .value()
                        .equals(t.id.value())
                        .and(g.userId.value().equals(ctx.user.id.value()))
                        .and(g.permission.value().equals(value("manage"))),
                    )
                    .exists(),
                ),
            ),
        )
        .exists(),
    )
    .permissions({
      read: (ctx) =>
        canReadTicket(ctx.roles, ctx.visibility.value().equals(value("public"))),
      create: (ctx) =>
        ctx.roles.opener.and(
          ctx
            .subselect(membership)
            .where((m) =>
              m.competitionId
                .value()
                .equals(ctx.competitionId.value())
                .and(m.userId.value().equals(ctx.user.id.value()))
                .and(m.role.value().equals(value("participant")))
                .and(m.status.value().in(["active", "banned"])),
            )
            .exists(),
        ),
      update: (ctx) =>
        canAnswerTicket(ctx.roles)
          .or(ctx.roles.opener)
          .or(ctx.roles.teammate),
    }),
);
