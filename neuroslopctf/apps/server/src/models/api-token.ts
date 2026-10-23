import { app } from "../app.js";

export class ApiToken {
  id!: number;
  userId!: number;
  name!: string;
  tokenHash!: string;
  prefix!: string;
  scopes!: string;
  competitionId!: number | null;
  createdAt!: Date;
  expiresAt!: Date | null;
  lastUsedAt!: Date | null;
}

export const apiToken = app.define("api_token", ApiToken, (d) =>
  d
    .grant("owner", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.owner,
      create: (ctx) => ctx.roles.owner,
      delete: (ctx) => ctx.roles.owner,
    }),
);
