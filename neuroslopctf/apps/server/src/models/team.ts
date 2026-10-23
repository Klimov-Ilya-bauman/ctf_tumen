import { app } from "../app.js";
import { competition } from "./competition.js";

export class Team {
  id!: number;
  competitionId!: number;
  name!: string;
  captainId!: number;
  joinCode!: string;
  createdAt!: Date;
}

export const team = app.define("team", Team, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .grant("captain", (ctx) =>
      ctx.captainId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.staff.or(ctx.roles.player),
      create: (ctx) => ctx.roles.captain.and(ctx.roles.participant),
      update: (ctx) => ctx.roles.captain.or(ctx.roles.admin),
      delete: (ctx) => ctx.roles.captain.or(ctx.roles.admin),
    }),
);
