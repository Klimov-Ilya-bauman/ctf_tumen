import {
  value,
  type ContextAccessor,
  type Expression,
  type Resource,
} from "@backend/thingamajig";
import { app } from "../app.js";
import { competitionOf } from "./access.js";
import { competition } from "./competition.js";

export class Membership {
  competitionId!: number;
  userId!: number;
  role!: "owner" | "admin" | "author" | "reviewer" | "participant" | "observer";
  status!: "invited" | "pending" | "active" | "banned";
  invitedBy!: number | null;
  teamId!: number | null;
  teamJoinedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const membership: Resource<Membership> = app.define(
  "membership",
  Membership,
  (d) =>
    d
      .inherit(competition, (ctx) =>
        ctx.left.competitionId.value().equals(ctx.right.id.value()),
      )
      .grant("owner", (ctx) =>
        ctx.userId.value().equals(ctx.user.id.value()),
      )
      .permissions({
        read: (ctx) =>
          ctx.userId
            .value()
            .equals(ctx.user.id.value())
            .or(ctx.roles.staff)
            .or(ctx.roles.player.and(hasStatus(ctx, "active"))),
        create: (ctx) =>
          ctx.userId
            .value()
            .equals(ctx.user.id.value())
            .and(hasRole(ctx, "owner"))
            .and(
              competitionOf(ctx, ctx.competitionId.value(), (c) =>
                c.ownerId.value().equals(ctx.user.id.value()),
              ),
            )
            .or(
              ctx.userId
                .value()
                .equals(ctx.user.id.value())
                .and(hasRole(ctx, "participant"))
                .and(
                  competitionOf(ctx, ctx.competitionId.value(), (c) =>
                    c.state
                      .value()
                      .in(["scheduled", "running", "frozen"])
                      .and(c.visibility.value().notEquals(value("private")))
                      .and(
                      hasStatus(ctx, "active")
                        .and(c.joinPolicy.value().equals(value("open")))
                        .or(
                          hasStatus(ctx, "pending").and(
                            c.joinPolicy.value().equals(value("approval")),
                          ),
                        ),
                    ),
                  ),
                ),
            )
            .or(
            competitionOf(ctx, ctx.competitionId.value(), (c) =>
              c.ownerId.value().equals(ctx.user.id.value()),
            )
              .and(hasRole(ctx, "owner").not())
              .or(
                ctx.roles.admin.and(
                  ctx.role
                    .value()
                    .in(["author", "reviewer", "participant", "observer"]),
                ),
              ),
          ),
        update: (ctx) => managesRow(ctx),
        delete: (ctx) =>
          ctx.userId
            .value()
            .equals(ctx.user.id.value())
            .and(hasRole(ctx, "owner").not())
            .and(hasStatus(ctx, "banned").not())
            .or(
            competitionOf(ctx, ctx.competitionId.value(), (c) =>
              c.ownerId.value().equals(ctx.user.id.value()),
            )
              .and(hasRole(ctx, "owner").not())
              .or(
                ctx.roles.admin.and(
                  ctx.role
                    .value()
                    .in(["author", "reviewer", "participant", "observer"]),
                ),
              ),
          ),
      }),
);

type Row = ContextAccessor<Membership>;

function hasRole(ctx: Row, role: Membership["role"]) {
  return ctx.role.value().equals(value(role));
}

function hasStatus(ctx: Row, status: Membership["status"]) {
  return ctx.status.value().equals(value(status));
}

function managesRow(ctx: Row & { roles: Record<"owner" | "admin", Expression<boolean, any>> }) {
  return ctx.roles.owner
    .and(hasRole(ctx, "owner").not())
    .or(
      ctx.roles.admin.and(
        ctx.role.value().in(["author", "reviewer", "participant", "observer"]),
      ),
    );
}
