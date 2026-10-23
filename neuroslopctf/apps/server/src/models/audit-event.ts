import { app } from "../app.js";
import { competition } from "./competition.js";

export class AuditEvent {
  id!: number;
  competitionId!: number;
  actorId!: number;
  action!: string;
  targetType!: string;
  targetId!: number;
  data!: Record<string, unknown>;
  createdAt!: Date;
}

export const auditEvent = app.define("audit_event", AuditEvent, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.admin,
    }),
);
