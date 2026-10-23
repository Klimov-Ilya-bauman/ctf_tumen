import { app } from "../app.js";
import { canEditTask, canReadTaskSecrets } from "./access.js";
import { task } from "./task.js";

export class TaskRevision {
  id!: number;
  taskId!: number;
  revision!: number;
  title!: string;
  description!: string;
  category!: string;
  difficulty!: string;
  basePoints!: number;
  answerFlag!: string;
  rewardToken!: string;
  releaseAt!: Date | null;
  createdBy!: number;
  createdAt!: Date;
}

export const taskRevision = app.define("task_revision", TaskRevision, (d) =>
  d
    .inherit(task, (ctx) =>
      ctx.left.taskId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) => canReadTaskSecrets(ctx.roles),
      create: (ctx) => canEditTask(ctx.roles),
    }),
);
