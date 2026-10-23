import { app } from "../app.js";
import { canEditTask, canReadTask, taskOf } from "./access.js";
import { task } from "./task.js";

export class Hint {
  id!: number;
  taskId!: number;
  order!: number;
  body!: string;
  cost!: number;
}

export const hint = app.define("hint", Hint, (d) =>
  d
    .inherit(task, (ctx) =>
      ctx.left.taskId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) =>
        canReadTask(ctx.roles, (has) => taskOf(ctx, ctx.taskId.value(), has)),
      create: (ctx) => canEditTask(ctx.roles),
      update: (ctx) => canEditTask(ctx.roles),
      delete: (ctx) => canEditTask(ctx.roles),
    }),
);
