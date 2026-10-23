import { app } from "../app.js";

export class CompetitionPin {
  id!: number;
  userId!: number;
  competitionId!: number;
  createdAt!: Date;
}

export const competitionPin = app.define("competition_pin", CompetitionPin, (d) =>
  d
    .grant("owner", (ctx) => ctx.userId.value().equals(ctx.user.id.value()))
    .permissions({
      read: (ctx) => ctx.roles.owner,
      create: (ctx) => ctx.roles.owner,
      delete: (ctx) => ctx.roles.owner,
    }),
);
