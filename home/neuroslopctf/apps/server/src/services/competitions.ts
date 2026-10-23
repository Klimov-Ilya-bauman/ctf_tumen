import { orm } from "../app.js";
import type { Competition } from "../models/competition.js";
import type { Membership } from "../models/membership.js";
import { competitionSummaryDto, type CompetitionStats } from "./dto.js";
import { lit } from "./sql.js";

export async function competitionStats(
  competition: Competition,
): Promise<CompetitionStats> {
  const id = lit(competition.id);
  const [row] = await orm.raw<Record<keyof CompetitionStats, string>>(`
    SELECT
      (SELECT COUNT(*) FROM "membership" WHERE "competitionId" = ${id}
        AND "role" = 'participant' AND "status" = 'active') AS "participants",
      (SELECT COUNT(*) FROM "team" WHERE "competitionId" = ${id}) AS "teams",
      (SELECT COUNT(*) FROM "task" WHERE "competitionId" = ${id}
        AND "state" = 'published') AS "tasks_published",
      (SELECT COUNT(*) FROM "solve" WHERE "competitionId" = ${id}) AS "solves",
      (SELECT COUNT(*) FROM "submission" WHERE "competitionId" = ${id}) AS "submissions"`);

  return {
    participants: Number(row?.participants ?? 0),
    teams: Number(row?.teams ?? 0),
    tasks_published: Number(row?.tasks_published ?? 0),
    solves: Number(row?.solves ?? 0),
    submissions: Number(row?.submissions ?? 0),
  };
}

export async function competitionSummaries(
  competitions: Competition[],
  viewerId: number | null,
) {
  if (competitions.length === 0) {
    return [];
  }

  const ids = competitions.map((competition) => lit(competition.id)).join(", ");
  const ownerIds = [
    ...new Set(competitions.map((competition) => lit(competition.ownerId))),
  ].join(", ");

  const [owners, counts, memberships] = await Promise.all([
    orm.raw<{ id: number; username: string }>(
      `SELECT "id", "username" FROM "user" WHERE "id" IN (${ownerIds})`,
    ),
    orm.raw<{ competitionId: number; count: string }>(`
      SELECT "competitionId", COUNT(*) AS "count" FROM "membership"
      WHERE "competitionId" IN (${ids}) AND "role" = 'participant' AND "status" = 'active'
      GROUP BY "competitionId"`),
    viewerId === null
      ? Promise.resolve([] as Membership[])
      : orm.raw<Membership>(`
        SELECT * FROM "membership"
        WHERE "competitionId" IN (${ids}) AND "userId" = ${lit(viewerId)}`),
  ]);

  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const countById = new Map(
    counts.map((row) => [row.competitionId, Number(row.count)]),
  );
  const membershipById = new Map(
    memberships.map((membership) => [membership.competitionId, membership]),
  );

  return competitions.map((competition) =>
    competitionSummaryDto(
      competition,
      ownerById.get(competition.ownerId) ?? {
        id: competition.ownerId,
        username: "",
      },
      countById.get(competition.id) ?? 0,
      membershipById.get(competition.id) ?? null,
    ),
  );
}

export async function applyScheduledTransitions() {
  await orm.raw(`
    UPDATE "competition" SET "state" = 'running', "updatedAt" = now()
    WHERE "state" = 'scheduled' AND "startsAt" <= now();

    UPDATE "competition"
    SET "state" = 'frozen', "freezeApplied" = true, "frozenAt" = "freezeAt",
      "updatedAt" = now()
    WHERE "state" = 'running' AND NOT "freezeApplied"
      AND "freezeAt" IS NOT NULL AND "freezeAt" <= now() AND "endsAt" > now();

    UPDATE "competition" SET "state" = 'finished', "frozenAt" = NULL, "updatedAt" = now()
    WHERE "state" IN ('running', 'frozen') AND "endsAt" <= now();
  `);
}
