import { action } from "@backend/thingamajig";
import { orm, type User } from "../app.js";
import type { Competition } from "../models/competition.js";
import { competitionSummaries } from "../services/competitions.js";
import { userDto } from "../services/dto.js";
import { currentUser, notFound, type Ctx } from "../services/http.js";
import { lit } from "../services/sql.js";

export class UserController {
  @action("GET", "/users/:username")
  async show(ctx: Ctx) {
    const username = ctx.params.username ?? "";
    const [found] = await orm.raw<User>(
      `SELECT * FROM "user" WHERE lower("username") = lower(${lit(username)})`,
    );

    if (!found) {
      throw notFound("User");
    }

    const competitions = await orm.raw<Competition>(`
        SELECT c.* FROM "competition" c
        WHERE c."visibility" = 'public' AND c."state" <> 'draft'
          AND EXISTS (SELECT 1 FROM "membership" m
            WHERE m."competitionId" = c."id" AND m."userId" = ${lit(found.id)}
              AND m."status" = 'active')
        ORDER BY c."startsAt" DESC`);

    return {
      ...userDto(found),
      competitions: await competitionSummaries(
        competitions,
        currentUser(ctx)?.id ?? null,
      ),
    };
  }
}
