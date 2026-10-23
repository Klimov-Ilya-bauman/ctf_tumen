import { action, HttpError, query, t, value, type Orm } from "@backend/thingamajig";
import { orm, sudo, type User } from "../app.js";
import { randomToken } from "../auth/secrets.js";
import { team, type Team } from "../models/team.js";
import { membership } from "../models/membership.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import { viewerOf } from "../services/dto.js";
import {
  loadCompetition,
  membershipOf,
  notFound,
  pageQuery,
  paginate,
  requireUser,
  type CompetitionContext,
  type Ctx,
} from "../services/http.js";
import { lit } from "../services/sql.js";
import { leaveTeam } from "../services/teams.js";
import { escapeLike } from "./competitions.js";

const listQuery = pageQuery.extend({ q: t.string({ max: 100 }).optional() });
const nameField = t.string({ min: 1, max: 64 });

const updateBody = t.object({
  name: nameField.optional(),
  captain_id: t.int({ min: 1 }).optional(),
  regenerate_code: t.boolean().optional(),
});

export class TeamController {
  @action("GET", "/competitions/:cid/teams", { scope: "competitions:read" })
  async list(ctx: Ctx) {
    const cc = await teamContext(ctx);

    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(team)
      .where((t) => t.competitionId.value().equals(value(id)))
      .orderBy((t) => t.name.value());

    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      select.where((t) => t.name.value().ilike(value(pattern)));
    }

    return paginate(select, filters, (rows) =>
      rows.map((row) => teamDto(cc, row, false)),
    );
  }

  @action("POST", "/competitions/:cid/teams", { scope: "competitions:write" })
  async create(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);
    requireTeamless(cc);
    const { name } = await ctx.validBody(t.object({ name: nameField }));

    const [created] = await orm.execute(
      query().insert(team, {
        competitionId: cc.competition.id,
        name,
        captainId: user.id,
        joinCode: randomToken(12),
      }),
    );

    await sudo(() => assignTeam(orm, cc.competition.id, user.id, created!.id));

    ctx.response.status = 201;
    return this.detail(await reload(cc, created!.id), cc, user.id);
  }

  @action("GET", "/competitions/:cid/teams/:tid", {
    scope: "competitions:read",
  })
  async show(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);

    return this.detail(await findTeam(cc, ctx.params.tid), cc, user.id);
  }

  @action("PATCH", "/competitions/:cid/teams/:tid", {
    scope: "competitions:write",
  })
  async update(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);
    const found = await findTeam(cc, ctx.params.tid);

    const body = camelKeys(await ctx.validBody(updateBody));

    if (body.captainId !== undefined && body.captainId !== found.captainId) {
      const candidate = await membershipOf(cc.competition.id, body.captainId);

      if (candidate?.teamId !== found.id) {
        throw new HttpError(
          409,
          "The new captain must be a team member",
          "not_team_member",
        );
      }
    }

    await orm.execute(
      query()
        .update(team, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.captainId !== undefined
            ? { captainId: body.captainId }
            : {}),
          ...(body.regenerateCode ? { joinCode: randomToken(12) } : {}),
        })
        .where((t) => t.id.value().equals(value(found.id))),
    );

    return this.detail(await reload(cc, found.id), cc, user.id);
  }

  @action("DELETE", "/competitions/:cid/teams/:tid", {
    scope: "competitions:write",
  })
  async remove(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);
    const found = await findTeam(cc, ctx.params.tid);

    if (!cc.permissions.includes("teams.manage")) {
      const [row] = await orm.raw<{ count: string }>(
        `SELECT COUNT(*) AS "count" FROM "solve" WHERE "teamId" = ${lit(found.id)}`,
      );

      if (Number(row?.count ?? 0) > 0) {
        throw new HttpError(
          409,
          "A team with solves can't be deleted by its captain",
          "team_has_solves",
        );
      }
    }

    await orm.execute(
      query()
        .delete(team)
        .where((t) => t.id.value().equals(value(found.id))),
    );

    await audit(
      cc.competition.id,
      user,
      "team.deleted",
      {
        type: "team",
        id: found.id,
      },
      { name: found.name },
    );
  }

  @action("POST", "/competitions/:cid/teams/:tid/join", {
    scope: "competitions:write",
  })
  async join(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);
    const member = requireTeamlessParticipant(cc);
    const found = await findTeam(cc, ctx.params.tid);
    const { join_code } = await ctx.validBody(
      t.object({ join_code: t.string({ min: 1, max: 100 }) }),
    );

    if (join_code !== found.joinCode) {
      throw new HttpError(403, "Wrong team code", "wrong_join_code");
    }

    const [size] = await orm.raw<{ count: string }>(
      `SELECT COUNT(*) AS "count" FROM "membership" WHERE "teamId" = ${lit(found.id)}`,
    );

    if (Number(size?.count ?? 0) >= cc.competition.teamSizeMax) {
      throw new HttpError(409, "The team is full", "team_full");
    }

    await sudo(() => assignTeam(orm, member.competitionId, user.id, found.id));

    return this.detail(await reload(cc, found.id), cc, user.id);
  }

  @action("DELETE", "/competitions/:cid/teams/:tid/members/:uid", {
    scope: "competitions:write",
  })
  async removeMember(ctx: Ctx) {
    const cc = await teamContext(ctx);
    const user = requireUser(ctx);
    const found = await findTeam(cc, ctx.params.tid);
    const targetId = Number(ctx.params.uid);

    if (targetId !== user.id) {
      requireTeamManager(cc, found, user.id);
    }

    const target = Number.isInteger(targetId)
      ? await membershipOf(cc.competition.id, targetId)
      : null;

    if (!target || target.teamId !== found.id) {
      throw notFound("Team member");
    }

    await sudo(() => leaveTeam(orm, target));
  }

  private async detail(found: Team, cc: CompetitionContext, viewerId: number) {
    const members = await orm.raw<{
      userId: number;
      username: string;
      teamJoinedAt: Date;
    }>(`
      SELECT m."userId", u."username", m."teamJoinedAt"
      FROM "membership" m JOIN "user" u ON u."id" = m."userId"
      WHERE m."teamId" = ${lit(found.id)}
      ORDER BY m."teamJoinedAt", m."userId"`);
    const insider =
      members.some((member) => member.userId === viewerId) ||
      cc.permissions.includes("tasks.view_all");

    return {
      ...teamDto(cc, found, insider),
      members: members.map((member) => ({
        user_id: member.userId,
        username: member.username,
        joined_at: member.teamJoinedAt,
      })),
    };
  }
}

function teamDto(cc: CompetitionContext, row: Team, showCode: boolean) {
  const manager =
    cc.permissions.includes("teams.manage") || row.captainId === cc.user?.id;

  return {
    id: row.id,
    competition_id: row.competitionId,
    name: row.name,
    captain_id: row.captainId,
    ...(showCode ? { join_code: row.joinCode } : {}),
    created_at: row.createdAt,
    viewer: viewerOf(cc.membership, manager ? ["teams.manage"] : []),
  };
}

async function teamContext(ctx: Ctx) {
  const cc = await loadCompetition(ctx);
  requireUser(ctx);

  if (!cc.competition.teamMode) {
    throw new HttpError(409, "This competition has no teams", "teams_disabled");
  }

  return cc;
}

async function findTeam(cc: CompetitionContext, tid: string | undefined) {
  const id = Number(tid);
  const competitionId = cc.competition.id;
  const found = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(team)
          .where((t) =>
            t.id
              .value()
              .equals(value(id))
              .and(t.competitionId.value().equals(value(competitionId))),
          ),
      )
    : null;

  if (!found) {
    throw notFound("Team");
  }

  return found;
}

async function reload(cc: CompetitionContext, id: number) {
  return findTeam(cc, String(id));
}

function assignTeam(
  tx: Orm<User>,
  competitionId: number,
  userId: number,
  teamId: number,
) {
  return tx.execute(
    query()
      .update(membership, { teamId, teamJoinedAt: new Date() })
      .where((m) =>
        m.competitionId
          .value()
          .equals(value(competitionId))
          .and(m.userId.value().equals(value(userId))),
      ),
  );
}

function requireTeamless(cc: CompetitionContext) {
  if (cc.membership?.teamId !== null && cc.membership?.teamId !== undefined) {
    throw new HttpError(409, "You are already in a team", "already_in_team");
  }
}

function requireTeamlessParticipant(cc: CompetitionContext) {
  const member = cc.membership;

  if (!member || member.status !== "active" || member.role !== "participant") {
    throw new HttpError(
      403,
      "Only active participants can be in a team",
      "forbidden",
    );
  }

  if (member.teamId !== null) {
    throw new HttpError(409, "You are already in a team", "already_in_team");
  }

  return member;
}

function requireTeamManager(
  cc: CompetitionContext,
  found: Team,
  userId: number,
) {
  if (found.captainId !== userId && !cc.permissions.includes("teams.manage")) {
    throw new HttpError(
      403,
      "Only the captain or an admin can do this",
      "forbidden",
    );
  }
}
