import { app } from "../app.js";

export class Session {
  token!: string;
  userId!: number;
  createdAt!: Date;
  expiresAt!: Date;
}

export const session = app.define("session", Session, (d) =>
  d
    .grant("owner", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.owner,
      delete: (ctx) => ctx.roles.owner,
    }),
);
