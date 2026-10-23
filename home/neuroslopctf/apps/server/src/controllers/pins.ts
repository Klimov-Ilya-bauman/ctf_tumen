import { action, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { competitionPin } from "../models/competition-pin.js";
import { camelKeys } from "../services/case.js";
import { notFound, requireUser, type Ctx } from "../services/http.js";

const createBody = t.object({
  competition_id: t.int({ min: 1 }),
});

export class PinController {
  @action("GET", "/pins", { sessionOnly: true })
  async list(ctx: Ctx) {
    requireUser(ctx);
    const pins = await orm.fetchAll(
      query()
        .select(competitionPin)
        .orderBy((p) => p.id.value(), "desc"),
    );

    return { items: pins.map(pinDto) };
  }

  @action("POST", "/pins", { sessionOnly: true })
  async create(ctx: Ctx) {
    const user = requireUser(ctx);
    const body = camelKeys(await ctx.validBody(createBody));
    const [created] = await orm.execute(
      query().insert(competitionPin, {
        userId: user.id,
        competitionId: body.competitionId,
      }),
    );

    ctx.response.status = 201;
    return pinDto(created!);
  }

  @action("DELETE", "/pins/:id", { sessionOnly: true })
  async remove(ctx: Ctx) {
    requireUser(ctx);
    const id = Number(ctx.params.id);
    const [removed] = Number.isInteger(id)
      ? await orm.execute(
          query()
            .delete(competitionPin)
            .where((p) => p.id.value().equals(value(id))),
        )
      : [];

    if (!removed) {
      throw notFound("Pin");
    }
  }
}

function pinDto(pin: { id: number; competitionId: number; createdAt: Date }) {
  return {
    id: pin.id,
    competition_id: pin.competitionId,
    created_at: pin.createdAt,
  };
}
