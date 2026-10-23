import { app } from "../app.js";
import { competition } from "./competition.js";

export class JoinRequest {
  id!: number;
  competitionId!: number;
  userId!: number;
  message!: string;
  status!: "pending" | "approved" | "rejected";
  decidedBy!: number | null;
  createdAt!: Date;
  decidedAt!: Date | null;
}

export const joinRequest = app.define("join_request", JoinRequest, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .grant("requester", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.admin.or(ctx.roles.requester),
      create: (ctx) => ctx.roles.requester,
      update: (ctx) => ctx.roles.admin,
    }),
);
