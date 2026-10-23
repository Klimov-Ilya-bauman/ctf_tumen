import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { SCOPES } from "../auth/middleware.js";
import { randomToken, sha256 } from "../auth/secrets.js";
import { apiToken } from "../models/api-token.js";
import { competition } from "../models/competition.js";
import { camelKeys } from "../services/case.js";
import { apiTokenDto } from "../services/dto.js";
import { notFound, requireUser, type Ctx } from "../services/http.js";

const createToken = t.object({
  name: t.string({ min: 1, max: 100 }),
  scopes: t.array(t.literal(SCOPES), { min: 1 }),
  competition_id: t.int({ min: 1 }).nullable().optional(),
  expires_in_days: t.int({ min: 1, max: 3650 }).optional(),
});

export class TokenController {
  @action("GET", "/tokens", { sessionOnly: true })
  async list(ctx: Ctx) {
    requireUser(ctx);
    const tokens = await orm.fetchAll(
      query()
        .select(apiToken)
        .orderBy((token) => token.id.value(), "desc"),
    );

    return { items: tokens.map(apiTokenDto) };
  }

  @action("POST", "/tokens", { sessionOnly: true })
  async create(ctx: Ctx) {
    const owner = requireUser(ctx);
    const body = camelKeys(await ctx.validBody(createToken));

    if (body.competitionId) {
      const bound = await orm.fetch(
        query()
          .select(competition)
          .where((c) => c.id.value().equals(value(body.competitionId!))),
      );

      if (!bound) {
        throw new HttpError(
          422,
          "Competition not found",
          "invalid_competition",
        );
      }
    }

    const token = `nsc_${randomToken()}`;
    const [created] = await orm.execute(
      query().insert(apiToken, {
        userId: owner.id,
        name: body.name,
        tokenHash: sha256(token),
        prefix: token.slice(0, 8),
        scopes: [...new Set(body.scopes)].join(","),
        competitionId: body.competitionId ?? null,
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 3600 * 1000)
          : null,
      }),
    );

    ctx.response.status = 201;
    return { ...apiTokenDto(created!), token };
  }

  @action("DELETE", "/tokens/:id", { sessionOnly: true })
  async remove(ctx: Ctx) {
    requireUser(ctx);
    const id = Number(ctx.params.id);
    const own = Number.isInteger(id)
      ? await orm.fetch(
          query()
            .select(apiToken)
            .where((token) => token.id.value().equals(value(id))),
        )
      : null;

    if (!own) {
      throw notFound("Token");
    }

    await orm.execute(
      query()
        .delete(apiToken)
        .where((token) => token.id.value().equals(value(id))),
    );
  }
}
