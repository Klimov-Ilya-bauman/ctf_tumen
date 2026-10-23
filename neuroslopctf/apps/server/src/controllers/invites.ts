import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm, sudo } from "../app.js";
import { randomToken } from "../auth/secrets.js";
import { competition } from "../models/competition.js";
import { invite } from "../models/invite.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import { competitionSummaries } from "../services/competitions.js";
import { inviteDto } from "../services/dto.js";
import {
  loadCompetition,
  notFound,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { grantableRoles } from "../services/permissions.js";
import { inviteValid } from "./members.js";

const createBody = t.object({
  role: t.literal(["admin", "author", "reviewer", "participant", "observer"]),
  max_uses: t.int({ min: 1 }).nullable().optional(),
  expires_in_hours: t
    .int({ min: 1, max: 24 * 365 })
    .nullable()
    .optional(),
});

export class InviteController {
  @action("GET", "/competitions/:cid/invites", { scope: "competitions:write" })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const id = cc.competition.id;
    const invites = await orm.fetchAll(
      query()
        .select(invite)
        .where((i) => i.competitionId.value().equals(value(id)))
        .orderBy((i) => i.createdAt.value(), "desc"),
    );

    return { items: invites.map(inviteDto) };
  }

  @action("POST", "/competitions/:cid/invites", { scope: "competitions:write" })
  async create(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);

    const body = camelKeys(await ctx.validBody(createBody));

    if (!grantableRoles(cc.role).includes(body.role)) {
      throw new HttpError(
        403,
        `You can't invite with the ${body.role} role`,
        "role_not_grantable",
      );
    }

    const [created] = await orm.execute(
      query().insert(invite, {
        code: randomToken(18),
        competitionId: cc.competition.id,
        role: body.role,
        createdBy: actor.id,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresInHours
          ? new Date(Date.now() + body.expiresInHours * 3600 * 1000)
          : null,
      }),
    );

    await audit(
      cc.competition.id,
      actor,
      "invite.created",
      {
        type: "invite",
        id: cc.competition.id,
      },
      { role: body.role, max_uses: body.maxUses ?? null },
    );

    ctx.response.status = 201;
    return inviteDto(created!);
  }

  @action("DELETE", "/competitions/:cid/invites/:code", {
    scope: "competitions:write",
  })
  async revoke(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);

    const code = ctx.params.code ?? "";
    const id = cc.competition.id;
    const [revoked] = await orm.execute(
      query()
        .update(invite, { revoked: true })
        .where((i) =>
          i.code
            .value()
            .equals(value(code))
            .and(i.competitionId.value().equals(value(id))),
        ),
    );

    if (!revoked) {
      throw notFound("Invite");
    }

    await audit(
      id,
      actor,
      "invite.revoked",
      { type: "invite", id },
      {
        role: revoked.role,
      },
    );
  }

  @action("GET", "/invites/:code")
  async preview(ctx: Ctx) {
    const user = requireUser(ctx);
    const code = ctx.params.code ?? "";
    const found = await sudo(() =>
      orm.fetch(
        query()
          .select(invite)
          .where((i) => i.code.value().equals(value(code))),
      ),
    );

    if (!found) {
      throw notFound("Invite");
    }

    const target = await sudo(() =>
      orm.fetch(
        query()
          .select(competition)
          .where((c) => c.id.value().equals(value(found.competitionId))),
      ),
    );

    if (!target) {
      throw notFound("Invite");
    }

    const [summary] = await competitionSummaries([target], user.id);

    return {
      competition: summary,
      role: found.role,
      valid:
        inviteValid(found) &&
        ["scheduled", "running", "frozen"].includes(target.state),
    };
  }
}
