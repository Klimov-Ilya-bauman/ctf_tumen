import { query, type Orm } from "@backend/thingamajig";
import { orm as defaultOrm, sudo, type User } from "../app.js";
import { auditEvent } from "../models/audit-event.js";

export function audit(
  competitionId: number,
  actor: User,
  action: string,
  target: { type: string; id: number },
  data: Record<string, unknown> = {},
  orm: Orm<User> = defaultOrm,
) {
  return sudo(() =>
    orm.execute(
      query().insert(auditEvent, {
        competitionId: competitionId,
        actorId: actor.id,
        action,
        targetType: target.type,
        targetId: target.id,
        data,
      }),
    ),
  );
}
