import type { Resource } from "@backend/thingamajig";
import { app } from "../app.js";
import { canManageTask } from "./access.js";
import { task } from "./task.js";

export class TaskGrant {
  taskId!: number;
  userId!: number;
  permission!: "view" | "edit" | "manage";
  grantedBy!: number;
  createdAt!: Date;
}

export const taskGrant: Resource<TaskGrant> = app.define(
  "task_grant",
  TaskGrant,
  (d) =>
    d
      .inherit(task, (ctx) =>
        ctx.left.taskId.value().equals(ctx.right.id.value()),
      )
      .permissions({
        read: (ctx) => canManageTask(ctx.roles),
        create: (ctx) => canManageTask(ctx.roles),
        delete: (ctx) => canManageTask(ctx.roles),
      }),
);
