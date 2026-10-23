import { app } from "../app.js";
import { competition } from "./competition.js";

export class Invite {
  code!: string;
  competitionId!: number;
  role!: "admin" | "author" | "reviewer" | "participant" | "observer";
  createdBy!: number;
  maxUses!: number | null;
  uses!: number;
  expiresAt!: Date | null;
  revoked!: boolean;
  createdAt!: Date;
}

export const invite = app.define("invite", Invite, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.admin,
      create: (ctx) => ctx.roles.admin,
      update: (ctx) => ctx.roles.admin,
    }),
);
