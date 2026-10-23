import { value } from "@backend/thingamajig";
import { app } from "../app.js";
import { isListed } from "./access.js";
import { competitionPin } from "./competition-pin.js";
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
    .inherit(competitionPin, (ctx) =>
      ctx.left.id.value().equals(ctx.right.competitionId.value()),
    )
    .assign(
      ["owner", "admin", "author", "reviewer", "participant", "observer"],
      (ctx) =>
        ctx
          .subselect(membership)
          .where((m) =>
            m.userId
              .value()
              .equals(ctx.user.id.value())
              .and(m.status.value().equals(value("active"))),
          )
          .pick("role"),
    )
    .grant("owner", (ctx) => ctx.ownerId.value().equals(ctx.user.id.value()))
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
