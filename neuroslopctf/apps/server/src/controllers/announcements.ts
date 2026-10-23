import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { announcement } from "../models/announcement.js";
import { team } from "../models/team.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import { announcementDto } from "../services/dto.js";
import {
  loadCompetition,
  notFound,
  requireUser,
  type CompetitionContext,
  type Ctx,
} from "../services/http.js";

const announcementFields = {
  title: t.string({ min: 1, max: 200 }),
  body: t.string({ min: 1, max: 20000 }),
  audience: t.literal(["all", "staff", "team"]),
  team_id: t.int({ min: 1 }).nullable().optional(),
  pinned: t.boolean().default(false),
};

const createBody = t.object(announcementFields);
const updateBody = t
  .object({
    ...announcementFields,
    pinned: t.boolean(),
  })
  .partial();

export class AnnouncementController {
  @action("GET", "/competitions/:cid/announcements", {
    scope: "competitions:read",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);

    const id = cc.competition.id;
    const rows = await orm.fetchAll(
      query()
        .select(announcement)
        .where((a) => a.competitionId.value().equals(value(id)))
        .orderBy((a) => a.pinned.value(), "desc")
        .orderBy((a) => a.createdAt.value(), "desc"),
    );

    return { items: rows.map(announcementDto) };
  }

  @action("POST", "/competitions/:cid/announcements", {
    scope: "competitions:write",
  })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);

    const body = camelKeys(await ctx.validBody(createBody));
    const teamId = await audienceTeam(cc, body.audience, body.teamId ?? null);
    const [created] = await orm.execute(
      query().insert(announcement, {
        ...body,
        teamId: teamId,
        competitionId: cc.competition.id,
        authorId: actor.id,
      }),
    );

    await audit(
      cc.competition.id,
      actor,
      "announcement.created",
      {
        type: "announcement",
        id: created!.id,
      },
      { audience: body.audience },
    );

    ctx.response.status = 201;
    return announcementDto(created!);
  }

  @action("PATCH", "/competitions/:cid/announcements/:id", {
    scope: "competitions:write",
  })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const found = await findAnnouncement(cc, ctx.params.id);
    const body = camelKeys(await ctx.validBody(updateBody));
    const audience = body.audience ?? found.audience;
    const teamId = await audienceTeam(
      cc,
      audience,
      body.teamId !== undefined ? body.teamId : found.teamId,
    );
    const [updated] = await orm.execute(
      query()
        .update(announcement, { ...body, teamId: teamId })
        .where((a) => a.id.value().equals(value(found.id))),
    );

    return announcementDto(updated!);
  }

  @action("DELETE", "/competitions/:cid/announcements/:id", {
    scope: "competitions:write",
  })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const found = await findAnnouncement(cc, ctx.params.id);

    await orm.execute(
      query()
        .delete(announcement)
        .where((a) => a.id.value().equals(value(found.id))),
    );
  }
}

async function audienceTeam(
  cc: CompetitionContext,
  audience: "all" | "staff" | "team",
  teamId: number | null,
): Promise<number | null> {
  if (audience !== "team") {
    return null;
  }

  const competitionId = cc.competition.id;
  const found = teamId
    ? await orm.fetch(
        query()
          .select(team)
          .where((t) =>
            t.id
              .value()
              .equals(value(teamId))
              .and(t.competitionId.value().equals(value(competitionId))),
          ),
      )
    : null;

  if (!found) {
    throw new HttpError(
      422,
      "Team announcements need a team of this competition",
      "invalid_team",
    );
  }

  return found.id;
}

async function findAnnouncement(
  cc: CompetitionContext,
  rawId: string | undefined,
) {
  const id = Number(rawId);
  const competitionId = cc.competition.id;
  const found = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(announcement)
          .where((a) =>
            a.id
              .value()
              .equals(value(id))
              .and(a.competitionId.value().equals(value(competitionId))),
          ),
      )
    : null;

  if (!found) {
    throw notFound("Announcement");
  }

  return found;
}
