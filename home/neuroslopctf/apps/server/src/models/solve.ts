import { app } from "../app.js";
import { canPlay } from "./access.js";
import { membership } from "./membership.js";
import { task } from "./task.js";

export class Solve {
  id!: number;
  competitionId!: number;
  taskId!: number;
  userId!: number;
  teamId!: number | null;
  submissionId!: number;
  pointsAwarded!: number;
  solvedAt!: Date;
}

export const solve = app.define("solve", Solve, (d) =>
  d
    .inherit(task, (ctx) =>
      ctx.left.taskId.value().equals(ctx.right.id.value()),
    )
    .grant("solver", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .grant("teammate", (ctx) =>
      ctx
        .subselect(membership)
        .where((m) =>
          m.competitionId
            .value()
            .equals(ctx.competitionId.value())
            .and(m.userId.value().equals(ctx.user.id.value()))
            .and(m.teamId.value().equals(ctx.teamId.value())),
        )
        .exists(),
    )
    .permissions({
      read: (ctx) =>
        ctx.roles.solver.or(ctx.roles.teammate).or(ctx.roles.staff),
      create: (ctx) => ctx.roles.solver.and(canPlay(ctx)),
    }),
);
