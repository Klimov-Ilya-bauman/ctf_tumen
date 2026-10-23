import { action } from "@backend/thingamajig";
import { orm } from "../app.js";

export class PlatformController {
  @action("GET", "/health")
  health() {
    return { status: "ok", service: "neuroslopctf" };
  }

  @action("GET", "/stats")
  async stats() {
    const [row] = await orm.raw<Record<string, string>>(`
        SELECT
          (SELECT COUNT(*) FROM "user") AS "users",
          (SELECT COUNT(*) FROM "competition" WHERE "visibility" = 'public' AND "state" <> 'draft') AS "competitions",
          (SELECT COUNT(*) FROM "competition" WHERE "visibility" = 'public' AND "state" IN ('running', 'frozen')) AS "running_competitions",
          (SELECT COUNT(*) FROM "task" t JOIN "competition" c ON c."id" = t."competitionId"
            WHERE c."visibility" = 'public' AND c."state" IN ('running', 'frozen', 'finished', 'archived')
              AND t."state" = 'published' AND (t."releaseAt" IS NULL OR t."releaseAt" <= now())) AS "tasks",
          (SELECT COUNT(*) FROM "solve" s JOIN "competition" c ON c."id" = s."competitionId"
            WHERE c."visibility" = 'public' AND c."state" <> 'draft'
              AND (c."frozenAt" IS NULL OR s."solvedAt" <= c."frozenAt")) AS "solves"`);

    return {
      users: Number(row?.users ?? 0),
      competitions: Number(row?.competitions ?? 0),
      running_competitions: Number(row?.running_competitions ?? 0),
      tasks: Number(row?.tasks ?? 0),
      solves: Number(row?.solves ?? 0),
    };
  }
}
