import { value, type ContextAccessor } from "@backend/thingamajig";
import { app } from "../app.js";
import { competitionOf, isListed } from "./access.js";
import { membership } from "./membership.js";
import { competition } from "./competition.js";

export class Announcement {
  id!: number;
  competitionId!: number;
  authorId!: number;
  audience!: "all" | "staff" | "team";
  teamId!: number | null;
  title!: string;
  body!: string;
  pinned!: boolean;
  createdAt!: Date;
}

export const announcement = app.define("announcement", Announcement, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) =>
        ctx.roles.staff
          .or(
            hasAudience(ctx, "all").and(
              ctx.roles.player.or(
                competitionOf(ctx, ctx.competitionId.value(), isListed),
              ),
            ),
          )
          .or(
            hasAudience(ctx, "team").and(
              ctx
                .subselect(membership)
                .where((m) =>
                  m.competitionId
                    .value()
                    .equals(ctx.competitionId.value())
                    .and(m.userId.value().equals(ctx.user.id.value()))
                    .and(m.status.value().equals(value("active")))
                    .and(m.teamId.value().equals(ctx.teamId.value())),
                )
                .exists(),
            ),
          ),
      create: (ctx) => ctx.roles.admin,
      update: (ctx) => ctx.roles.admin,
      delete: (ctx) => ctx.roles.admin,
    }),
);

function hasAudience(
  ctx: ContextAccessor<Announcement>,
  audience: Announcement["audience"],
) {
  return ctx.audience.value().equals(value(audience));
}
