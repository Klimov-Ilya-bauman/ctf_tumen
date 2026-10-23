import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { joinRequest } from "../models/join-request.js";
import { membership } from "../models/membership.js";
import { audit } from "../services/audit.js";
import { joinRequestDto, membershipDto } from "../services/dto.js";
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
import { grantableRoles } from "../services/permissions.js";

const listQuery = pageQuery.extend({
  status: t.literal(["pending", "approved", "rejected"]).optional(),
});

const approveBody = t.object({
  role: t
    .literal(["admin", "author", "reviewer", "participant", "observer"])
    .default("participant"),
});

export class JoinRequestController {
  @action("GET", "/competitions/:cid/join-requests", {
    scope: "competitions:write",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const filters = ctx.validQuery(listQuery);
    const id = cc.competition.id;
    const select = query()
      .select(joinRequest)
      .where((r) => r.competitionId.value().equals(value(id)))
      .orderBy((r) => r.createdAt.value(), "desc");

    if (filters.status) {
      const status = filters.status;
      select.where((r) => r.status.value().equals(value(status)));
    }

    return paginate(select, filters, (rows) => rows.map(joinRequestDto));
  }

  @action("POST", "/competitions/:cid/join-requests/:id/approve", {
    scope: "competitions:write",
  })
  async approve(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);

    const request = await pendingRequest(cc, Number(ctx.params.id));
    const { role } = await ctx.validBody(approveBody);

    if (!grantableRoles(cc.role).includes(role)) {
      throw new HttpError(
        403,
        `You can't grant the ${role} role`,
        "role_not_grantable",
      );
    }

    const existing = await membershipOf(cc.competition.id, request.userId);
    const now = new Date();
    await orm.execute(
      query()
        .update(joinRequest, {
          status: "approved",
          decidedBy: actor.id,
          decidedAt: now,
        })
        .where((r) => r.id.value().equals(value(request.id))),
    );

    const [approved] = existing
      ? await orm.execute(
          query()
            .update(membership, { role, status: "active", updatedAt: now })
            .where((m) =>
              m.competitionId
                .value()
                .equals(value(request.competitionId))
                .and(m.userId.value().equals(value(request.userId))),
            ),
        )
      : await orm.execute(
          query().insert(membership, {
            competitionId: request.competitionId,
            userId: request.userId,
            role,
            status: "active",
          }),
        );

    await audit(
      cc.competition.id,
      actor,
      "join_request.approved",
      {
        type: "join_request",
        id: request.id,
      },
      { user_id: request.userId, role },
    );

    return membershipDto(approved!);
  }

  @action("POST", "/competitions/:cid/join-requests/:id/reject", {
    scope: "competitions:write",
  })
  async reject(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);

    const request = await pendingRequest(cc, Number(ctx.params.id));
    const [rejected] = await orm.execute(
      query()
        .update(joinRequest, {
          status: "rejected",
          decidedBy: actor.id,
          decidedAt: new Date(),
        })
        .where((r) => r.id.value().equals(value(request.id))),
    );

    await orm.execute(
      query()
        .delete(membership)
        .where((m) =>
          m.competitionId
            .value()
            .equals(value(request.competitionId))
            .and(m.userId.value().equals(value(request.userId)))
            .and(m.status.value().equals(value("pending"))),
        ),
    );

    await audit(
      cc.competition.id,
      actor,
      "join_request.rejected",
      {
        type: "join_request",
        id: request.id,
      },
      { user_id: request.userId },
    );

    return joinRequestDto(rejected!);
  }
}

async function pendingRequest(cc: CompetitionContext, id: number) {
  const competitionId = cc.competition.id;
  const request = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(joinRequest)
          .where((r) =>
            r.id
              .value()
              .equals(value(id))
              .and(r.competitionId.value().equals(value(competitionId))),
          ),
      )
    : null;

  if (!request) {
    throw notFound("Join request");
  }

  if (request.status !== "pending") {
    throw new HttpError(
      409,
      "This request was already decided",
      "already_decided",
    );
  }

  return request;
}
