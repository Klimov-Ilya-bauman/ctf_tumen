import { action, t } from "@backend/thingamajig";
import { loadCompetition, type Ctx } from "../services/http.js";
import { scoreboard } from "../services/scoring.js";

const pageQuery = t.object({
  limit: t.int({ min: 1, max: 500 }).default(50),
  offset: t.int({ min: 0 }).default(0),
});

export class ScoreboardController {
  @action("GET", "/competitions/:cid/scoreboard", {
    scope: "competitions:read",
  })
  async show(ctx: Ctx) {
    const cc = await loadCompetition(ctx);

    const page = ctx.validQuery(pageQuery);
    const frozen = cc.competition.state === "frozen";
    const cutoff =
      frozen && !cc.permissions.includes("scoreboard.live")
        ? (cc.competition.frozenAt ?? new Date())
        : null;
    const board = await scoreboard(cc.competition, cutoff, page);

    return {
      items: board.items,
      total: board.total,
      frozen,
      frozen_at: frozen ? cc.competition.frozenAt : null,
    };
  }
}
