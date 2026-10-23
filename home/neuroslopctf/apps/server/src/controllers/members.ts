import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm, sudo } from "../app.js";
import { competition, type Competition } from "../models/competition.js";
import { membership, type Membership } from "../models/membership.js";
import { invite } from "../models/invite.js";
import { joinRequest } from "../models/join-request.js";
import { audit } from "../services/audit.js";
import { membershipDto, viewerOf } from "../services/dto.js";
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
import { canManageMember } from "../services/permissions.js";
import { lit } from "../services/sql.js";
import { leaveTeam } from "../services/teams.js";
import { user } from "../models/user.js";
import { escapeLike } from "./competitions.js";

const ROLES = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "participant",
  "observer",
] as const;
const STATUSES = ["invited", "pending", "active", "banned"] as const;

const joinBody = t.object({
  invite_code: t.string({ max: 200 }).optional(),
  message: t.string({ max: 1000 }).optional(),
});

const listQuery = pageQuery.extend({
  role: t.literal(ROLES).optional(),
  status: t.literal(STATUSES).optional(),
  q: t.string({ max: 100 }).optional(),
});

const updateBody = t.object({
  role: t.literal(ROLES).optional(),
  status: t.literal(STATUSES).optional(),
});

export class MemberController {
  @action("POST", "/competitions/:cid/join", { scope: "competitions:write" })
  async join(ctx: Ctx) {
    const user = requireUser(ctx);
    const body = await ctx.validBody(joinBody);
    const target = await competitionByCid(ctx.params.cid ?? "");

    if (!target) {
      throw notFound("Competition");
    }

    const existing = await membershipOf(target.id, user.id);

    if (existing) {
      throw existing.status === "banned"
        ? new HttpError(403, "You are banned from this competition", "banned")
        : new HttpError(409, "You are already a member", "already_member");
    }

    if (!["scheduled", "running", "frozen"].includes(target.state)) {
      throw new HttpError(
        410,
        "Joining this competition is closed",
        "joining_closed",
      );
    }

    if (body.invite_code) {
      const code = body.invite_code;
      const found = await sudo(() =>
        orm.fetch(
          query()
            .select(invite)
            .where((i) =>
              i.code
                .value()
                .equals(value(code))
                .and(i.competitionId.value().equals(value(target.id))),
            ),
        ),
      );

      if (!found || !inviteValid(found)) {
        throw new HttpError(
          403,
          "The invite code is invalid or expired",
          "invalid_invite",
        );
      }

      const created = await sudo(async () => {
        await orm.execute(
          query()
            .update(invite, { uses: found.uses + 1 })
            .where((i) => i.code.value().equals(value(code))),
        );

        const [row] = await orm.execute(
          query().insert(membership, {
            competitionId: target.id,
            userId: user.id,
            role: found.role,
            status: "active",
            invitedBy: found.createdBy,
          }),
        );

        return row!;
      });

      return membershipDto(created);
    }

    const status = target.joinPolicy === "approval" ? "pending" : "active";
    const [created] = await orm.execute(
      query().insert(membership, {
        competitionId: target.id,
        userId: user.id,
        role: "participant",
        status,
      }),
    );

    if (status === "pending") {
      await orm.execute(
        query().insert(joinRequest, {
          competitionId: target.id,
          userId: user.id,
          message: body.message ?? "",
        }),
      );
    }

    return membershipDto(created!);
  }

  @action("POST", "/competitions/:cid/leave", { scope: "competitions:write" })
  async leave(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    if (!cc.membership) {
      throw new HttpError(409, "You are not a member", "not_member");
    }

    if (cc.membership.role === "owner") {
      throw new HttpError(
        409,
        "The owner can't leave; transfer ownership first",
        "owner_cannot_leave",
      );
    }

    await removeMembership(cc.membership);
  }

  @action("GET", "/competitions/:cid/members", { scope: "competitions:read" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(membership)
      .where((m) => m.competitionId.value().equals(value(id)))
      .orderBy((m) => m.createdAt.value())
      .orderBy((m) => m.userId.value());

    if (filters.role) {
      const role = filters.role;
      select.where((m) => m.role.value().equals(value(role)));
    }

    if (filters.status) {
      const status = filters.status;
      select.where((m) => m.status.value().equals(value(status)));
    }

    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      select.where((m) =>
        m
          .subselect(user)
          .where((u) =>
            u.id
              .value()
              .equals(m.userId.value())
              .and(u.username.value().ilike(value(pattern))),
          )
          .exists(),
      );
    }

    return paginate(select, filters, (rows) => memberDtos(cc, rows));
  }

  @action("PATCH", "/competitions/:cid/members/:uid", {
    scope: "competitions:write",
  })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const target = await findMember(cc, ctx.params.uid);
    const body = await ctx.validBody(updateBody);

    if (body.role !== undefined && body.role !== target.role) {
      if (body.role === "owner") {
        throw new HttpError(
          409,
          "Use transfer to change the owner",
          "use_transfer",
        );
      }
    }

    const changes = {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updatedAt: new Date(),
    };

    const [updated] = await orm.execute(
      query()
        .update(membership, changes)
        .where((m) =>
          m.competitionId
            .value()
            .equals(value(target.competitionId))
            .and(m.userId.value().equals(value(target.userId))),
        ),
    );

    if (body.role !== undefined && body.role !== target.role) {
      await audit(
        cc.competition.id,
        actor,
        "member.role_changed",
        {
          type: "user",
          id: target.userId,
        },
        { from: target.role, to: body.role },
      );
    }

    if (body.status !== undefined && body.status !== target.status) {
      await audit(
        cc.competition.id,
        actor,
        "member.status_changed",
        {
          type: "user",
          id: target.userId,
        },
        { from: target.status, to: body.status },
      );
    }

    const [dto] = await memberDtos(cc, [updated!]);
    return dto;
  }

  @action("DELETE", "/competitions/:cid/members/:uid", {
    scope: "competitions:write",
  })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const target = await findMember(cc, ctx.params.uid);

    await removeMembership(target);
    await audit(
      cc.competition.id,
      actor,
      "member.removed",
      {
        type: "user",
        id: target.userId,
      },
      { role: target.role },
    );
  }
}

async function findMember(cc: CompetitionContext, uid: string | undefined) {
  const userId = Number(uid);
  const target = Number.isInteger(userId)
    ? await membershipOf(cc.competition.id, userId)
    : null;

  if (!target) {
    throw notFound("Member");
  }

  return target;
}

async function competitionByCid(cid: string): Promise<Competition | null> {
  return sudo(() =>
    orm.fetch(
      query()
        .select(competition)
        .where((c) =>
          /^\d+$/.test(cid)
            ? c.id.value().equals(value(Number(cid)))
            : c.slug.value().equals(value(cid)),
        ),
    ),
  );
}

export function inviteValid(found: {
  revoked: boolean;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
}): boolean {
  return (
    !found.revoked &&
    (found.expiresAt === null || found.expiresAt > new Date()) &&
    (found.maxUses === null || found.uses < found.maxUses)
  );
}

async function removeMembership(target: Membership) {
  await orm.execute(
    query()
      .delete(membership)
      .where((m) =>
        m.competitionId
          .value()
          .equals(value(target.competitionId))
          .and(m.userId.value().equals(value(target.userId))),
      ),
  );
  await sudo(() => leaveTeam(orm, target));
}

export async function memberDtos(cc: CompetitionContext, rows: Membership[]) {
  if (rows.length === 0) {
    return [];
  }

  const userIds = rows.map((row) => lit(row.userId)).join(", ");
  const teamIds = rows
    .filter((row) => row.teamId !== null)
    .map((row) => lit(row.teamId!));
  const [users, teams] = await Promise.all([
    orm.raw<{ id: number; username: string }>(
      `SELECT "id", "username" FROM "user" WHERE "id" IN (${userIds})`,
    ),
    teamIds.length
      ? orm.raw<{ id: number; name: string }>(
          `SELECT "id", "name" FROM "team" WHERE "id" IN (${teamIds.join(", ")})`,
        )
      : Promise.resolve([]),
  ]);
  const usernames = new Map(users.map((u) => [u.id, u.username]));
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const manager = cc.permissions.includes("members.manage");

  return rows.map((row) => {
    const rowPermissions =
      manager && canManageMember(cc.role, row)
        ? [
            "members.manage",
            ...(cc.permissions.includes("admins.manage")
              ? ["admins.manage"]
              : []),
          ]
        : [];
    const team = row.teamId !== null ? teamById.get(row.teamId) : undefined;

    return {
      user_id: row.userId,
      username: usernames.get(row.userId) ?? "",
      role: row.role,
      ...(manager ? { status: row.status, invited_by: row.invitedBy } : {}),
      ...(team ? { team: { id: team.id, name: team.name } } : {}),
      joined_at: row.createdAt,
      viewer: viewerOf(cc.membership, rowPermissions),
    };
  });
}
