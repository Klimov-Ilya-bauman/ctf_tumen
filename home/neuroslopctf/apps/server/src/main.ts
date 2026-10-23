import { fileURLToPath } from "node:url";
import { logger, migrate, serveStatic } from "@backend/thingamajig";
import { app, driver, orm } from "./app.js";
import { authenticate } from "./auth/middleware.js";
import { AnnouncementController } from "./controllers/announcements.js";
import { AttachmentController } from "./controllers/attachments.js";
import { AuditController } from "./controllers/audit.js";
import { AuthController } from "./controllers/auth.js";
import { CompetitionController } from "./controllers/competitions.js";
import { HintController } from "./controllers/hints.js";
import { InviteController } from "./controllers/invites.js";
import { JoinRequestController } from "./controllers/join-requests.js";
import { MemberController } from "./controllers/members.js";
import { PinController } from "./controllers/pins.js";
import { PlatformController } from "./controllers/platform.js";
import { ScoreboardController } from "./controllers/scoreboard.js";
import { SolveController } from "./controllers/solves.js";
import { SubmissionController } from "./controllers/submissions.js";
import { TaskGrantController } from "./controllers/task-grants.js";
import { TaskRevisionController } from "./controllers/task-revisions.js";
import { TaskController } from "./controllers/tasks.js";
import { TeamController } from "./controllers/teams.js";
import { TicketController } from "./controllers/tickets.js";
import { TokenController } from "./controllers/tokens.js";
import { UserController } from "./controllers/users.js";
import "./models/index.js";
import { applyScheduledTransitions } from "./services/competitions.js";

app.compile();

const frontendDist =
  process.env.FRONTEND_DIST ??
  fileURLToPath(new URL("../../frontend/dist", import.meta.url));

const migrations =
  process.env.MIGRATIONS_DIR ??
  fileURLToPath(new URL("../migrations", import.meta.url));

app.web
  .use(logger())
  .use(serveStatic(frontendDist, { exclude: ["/api"] }))
  .use(authenticate)
  .transactions((run) => orm.transaction(run));

for (const controller of [
  new PlatformController(),
  new AuthController(),
  new TokenController(),
  new PinController(),
  new UserController(),
  new CompetitionController(),
  new MemberController(),
  new InviteController(),
  new JoinRequestController(),
  new TeamController(),
  new TaskController(),
  new TaskRevisionController(),
  new TaskGrantController(),
  new AttachmentController(),
  new HintController(),
  new SubmissionController(),
  new SolveController(),
  new ScoreboardController(),
  new AnnouncementController(),
  new TicketController(),
  new AuditController(),
]) {
  app.web.controller("/api", controller);
}

for (const file of await migrate(driver, migrations)) {
  console.log(`Applied migration ${file}`);
}

await applyScheduledTransitions();
setInterval(() => {
  applyScheduledTransitions().catch((error) => console.error(error));
}, 5000).unref();

if (process.env.DESCRIBE !== "0") {
  console.log(`Models:\n${app.describe()}\n`);
  console.log(`Routes:\n${app.web.describe()}\n`);
}

const port = Number(process.env.PORT ?? 3000);
await app.web.listen(port);

console.log(`Listening on http://localhost:${port}`);
