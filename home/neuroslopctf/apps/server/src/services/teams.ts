import { query, value, type Orm } from "@backend/thingamajig";
import type { User } from "../app.js";
import { membership, type Membership } from "../models/membership.js";
import { team } from "../models/team.js";
import { lit } from "./sql.js";

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
  }>(`
    SELECT t."captainId",
      (SELECT m."userId" FROM "membership" m WHERE m."teamId" = t."id"
        ORDER BY m."teamJoinedAt", m."userId" LIMIT 1) AS "next_member",
      (SELECT COUNT(*) FROM "solve" s WHERE s."teamId" = t."id") AS "solves"
    FROM "team" t WHERE t."id" = ${lit(teamId)}`);

  if (!current) {
    return;
  }

  if (current.next_member === null) {
    if (Number(current.solves) === 0) {
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
