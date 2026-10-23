import { app } from "../app.js";
import { canPlay, canReadTask, taskOf } from "./access.js";
import { hint } from "./hint.js";

export class HintUnlock {
  hintId!: number;
  userId!: number;
  teamId!: number | null;
  competitionId!: number;
  cost!: number;
  unlockedAt!: Date;
}

export const hintUnlock = app.define("hint_unlock", HintUnlock, (d) =>
  d
    .inherit(hint, (ctx) =>
      ctx.left.hintId.value().equals(ctx.right.id.value()),
    )
    .grant("unlocker", (ctx) =>
      ctx.userId.value().equals(ctx.user.id.value()),
    )
    .permissions({
      read: (ctx) => ctx.roles.unlocker.or(ctx.roles.staff),
      create: (ctx) =>
        ctx.roles.unlocker
          .and(canPlay(ctx))
          .and(
            canReadTask(ctx.roles, (has) =>
              taskOf(
                ctx,
                ctx
                  .subselect(hint)
                  .where((h) => h.id.value().equals(ctx.hintId.value()))
                  .pick("taskId"),
                has,
              ),
            ),
          ),
    }),
);
