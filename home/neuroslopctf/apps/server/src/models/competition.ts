import { value } from "@backend/thingamajig";
import { app } from "../app.js";
import { isListed } from "./access.js";
import { membership } from "./membership.js";

export class Competition {
  id!: number;
  slug!: string;
  title!: string;
  description!: string;
  ownerId!: number;
  visibility!: "public" | "unlisted" | "private";
  joinPolicy!: "open" | "invite" | "approval";
  state!:
    | "draft"
    | "scheduled"
    | "running"
    | "frozen"
    | "finished"
    | "archived";
  startsAt!: Date;
  freezeAt!: Date | null;
  endsAt!: Date;
  freezeApplied!: boolean;
  frozenAt!: Date | null;
  teamMode!: boolean;
  teamSizeMax!: number;
  scoring!: "static" | "dynamic";
  createdAt!: Date;
  updatedAt!: Date;
}

export const competition = app.define("competition", Competition, (d) =>
  d
    .assign(
      ["owner", "admin", "author", "reviewer", "participant", "observer"],
      (ctx) =>
        ctx
          .subselect(membership)
          .where((m) =>
            m.userId
              .value()
              .equals(ctx.user.id.value())
              .and(m.competitionId.value().equals(ctx.id.value()))
              .and(m.status.value().equals(value("active"))),
          )
          .pick("role"),
    )
    .grant("owner", (ctx) => ctx.ownerId.value().equals(ctx.user.id.value()))
    .grant("member", (ctx) =>
      ctx.subselect(membership).where((m) =>
        m.competitionId.value().equals(ctx.id.value())
          .and(m.userId.value().equals(ctx.user.id.value())),
      ).exists(),
    )
    .implies("owner", ["admin", "member"])
    .implies("admin", ["staff", "member"])
    .implies("author", ["staff", "member"])
    .implies("reviewer", ["staff", "member"])
    .implies("participant", ["player", "member"])
    .implies("observer", ["player", "member"])
    .permissions({
      read: (ctx) => ctx.roles.member.or(isListed(ctx)),
      create: (ctx) => ctx.roles.owner,
      update: (ctx) => ctx.roles.admin,
      delete: (ctx) => ctx.roles.owner,
    }),
);
