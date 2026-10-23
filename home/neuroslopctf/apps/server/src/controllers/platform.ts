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
          (SELECT COUNT(*) FROM "competition" WHERE "state" <> 'draft') AS "competitions",
          (SELECT COUNT(*) FROM "competition" WHERE "state" IN ('running', 'frozen')) AS "running_competitions",
          (SELECT COUNT(*) FROM "task" WHERE "state" = 'published') AS "tasks",
          (SELECT COUNT(*) FROM "solve") AS "solves"`);

    return {
      users: Number(row?.users ?? 0),
      competitions: Number(row?.competitions ?? 0),
      running_competitions: Number(row?.running_competitions ?? 0),
      tasks: Number(row?.tasks ?? 0),
      solves: Number(row?.solves ?? 0),
    };
  }
}
