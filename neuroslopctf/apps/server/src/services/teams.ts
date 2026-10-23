import { HttpError, query, value, type Orm } from "@backend/thingamajig";
import { orm, type User } from "../app.js";
import { membership, type Membership } from "../models/membership.js";
import { team } from "../models/team.js";
import { lit } from "./sql.js";

// Team changes after scoring activity would launder hint costs or solves.
// Competition administrators may still moderate teams explicitly.
export async function requireUnscoredTeam(competitionId: number, userId: number, teamId: number | null) {
  const [row] = await orm.raw<{ active: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM "solve" WHERE "competitionId" = $1
      AND ("userId" = $2 OR "teamId" = $3)) OR
      EXISTS (SELECT 1 FROM "hint_unlock" WHERE "competitionId" = $1
      AND ("userId" = $2 OR "teamId" = $3)) AS "active"`, [competitionId, userId, teamId]);
  if (row?.active) throw new HttpError(409, "Team membership is locked after solves or hint purchases", "team_has_activity");
}

export async function leaveTeam(tx: Orm<User>, member: Membership) {
  if (member.teamId === null) {
    return;
  }

  const teamId = member.teamId;

  await tx.execute(
    query()
      .update(membership, { teamId: null, teamJoinedAt: null })
      .where((m) =>
        m.competitionId
          .value()
          .equals(value(member.competitionId))
          .and(m.userId.value().equals(value(member.userId))),
      ),
  );

  const [current] = await tx.raw<{
    captainId: number;
    next_member: number | null;
    solves: string;
    hints: string;
  }>(`
    SELECT t."captainId",
      (SELECT m."userId" FROM "membership" m WHERE m."teamId" = t."id"
        ORDER BY m."teamJoinedAt", m."userId" LIMIT 1) AS "next_member",
      (SELECT COUNT(*) FROM "solve" s WHERE s."teamId" = t."id") AS "solves",
      (SELECT COUNT(*) FROM "hint_unlock" h WHERE h."teamId" = t."id") AS "hints"
    FROM "team" t WHERE t."id" = ${lit(teamId)}`);

  if (!current) {
    return;
  }

  if (current.next_member === null) {
    if (Number(current.solves) === 0 && Number(current.hints) === 0) {
      await tx.execute(
        query()
          .delete(team)
          .where((t) => t.id.value().equals(value(teamId))),
      );
    }
  } else if (current.captainId === member.userId) {
    const captain = current.next_member;

    await tx.execute(
      query()
        .update(team, { captainId: captain })
        .where((t) => t.id.value().equals(value(teamId))),
    );
  }
}
