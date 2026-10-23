import { app } from "../app.js";
import {
  canManageTask,
  canPlay,
  canReadTask,
  taskOf,
} from "./access.js";
import { task } from "./task.js";

export class Submission {
  id!: number;
  competitionId!: number;
  taskId!: number;
  userId!: number;
  teamId!: number | null;
  value!: string;
  correct!: boolean;
  createdAt!: Date;
}

export const submission = app.define("submission", Submission, (d) =>
  d
    .inherit(task, (ctx) =>
      ctx.left.taskId.value().equals(ctx.right.id.value()),
    )
    .grant("submitter", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) =>
        ctx.roles.submitter.or(canManageTask(ctx.roles)),
      create: (ctx) =>
        ctx.roles.submitter
          .and(canPlay(ctx))
          .and(canReadTask(ctx.roles, (has) => taskOf(ctx, ctx.taskId.value(), has))),
    }),
);
