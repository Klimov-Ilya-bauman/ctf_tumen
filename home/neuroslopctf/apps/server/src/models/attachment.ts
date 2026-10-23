import { value } from "@backend/thingamajig";
import { app } from "../app.js";
import {
  canEditTask,
  canReadTask,
  canReadTaskSecrets,
  taskOf,
} from "./access.js";
import { task } from "./task.js";

export class Attachment {
  id!: number;
  taskId!: number;
  filename!: string;
  contentType!: string;
  size!: number;
  sha256!: string;
  storageKey!: string;
  visibility!: "participants" | "staff";
  uploadedBy!: number;
  createdAt!: Date;
}

export const attachment = app.define("attachment", Attachment, (d) =>
  d
    .inherit(task, (ctx) =>
      ctx.left.taskId.value().equals(ctx.right.id.value()),
    )
    .permissions({
      read: (ctx) =>
        canReadTaskSecrets(ctx.roles).or(
          ctx.visibility
            .value()
            .equals(value("participants"))
            .and(canReadTask(ctx.roles, (has) => taskOf(ctx, ctx.taskId.value(), has))),
        ),
      create: (ctx) => canEditTask(ctx.roles),
      update: (ctx) => canEditTask(ctx.roles),
      delete: (ctx) => canEditTask(ctx.roles),
    }),
);
