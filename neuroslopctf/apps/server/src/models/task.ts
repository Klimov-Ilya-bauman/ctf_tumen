import type { ContextAccessor } from "@backend/thingamajig";
import { app, type User } from "../app.js";
import { taskGrant, type TaskGrant } from "./task-grant.js";
import { canEditTask, canManageTask, canReadTask } from "./access.js";
import { competition } from "./competition.js";

export class Task {
  id!: number;
  competitionId!: number;
  slug!: string;
  authorId!: number;
  title!: string;
  description!: string;
  category!: string;
  difficulty!: "easy" | "medium" | "hard";
  basePoints!: number;
  answerFlag!: string;
  rewardToken!: string;
  state!: "draft" | "review" | "published" | "hidden" | "archived";
  releaseAt!: Date | null;
  maxSolves!: number | null;
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const task = app.define("task", Task, (d) =>
  d
    .inherit(competition, (ctx) =>
      ctx.left.competitionId.value().equals(ctx.right.id.value()),
    )
    .grant("viewer", (ctx) => hasGrant(ctx, ["view", "edit", "manage"]))
    .grant("editor", (ctx) => hasGrant(ctx, ["edit", "manage"]))
    .grant("manager", (ctx) =>
      ctx.authorId
        .value()
        .equals(ctx.user.id.value())
        .or(hasGrant(ctx, ["manage"])),
    )
    .implies("admin", ["manager"])
    .implies("manager", ["editor"])
    .implies("editor", ["viewer"])
    .permissions({
      read: (ctx) => canReadTask(ctx.roles, (has) => has(ctx)),
      create: (ctx) =>
        ctx.authorId
          .value()
          .equals(ctx.user.id.value())
          .and(ctx.roles.admin.or(ctx.roles.author)),
      update: (ctx) => canEditTask(ctx.roles).or(ctx.roles.reviewer),
      delete: (ctx) => canManageTask(ctx.roles),
    }),
);

function hasGrant(
  ctx: ContextAccessor<Task> & { user: ContextAccessor<User> },
  permissions: TaskGrant["permission"][],
) {
  return ctx
    .subselect(taskGrant)
    .where((g) =>
      g.taskId
        .value()
        .equals(ctx.id.value())
        .and(g.userId.value().equals(ctx.user.id.value()))
        .and(g.permission.value().in(permissions)),
    )
    .exists();
}
