import { createHash } from "node:crypto";
import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm } from "../app.js";
import { attachment } from "../models/attachment.js";
import { audit } from "../services/audit.js";
import { attachmentDto } from "../services/dto.js";
import {
  loadCompetition,
  notFound,
  requireUser,
  type CompetitionContext,
  type Ctx,
} from "../services/http.js";
import { lit } from "../services/sql.js";
import { deleteFile, openFile, saveFile } from "../services/storage.js";
import { loadTask } from "../services/tasks.js";
import { task as taskModel } from "../models/task.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES_PER_TASK = 10;
const VISIBILITIES = ["participants", "staff"] as const;

const updateBody = t.object({
  visibility: t.literal(VISIBILITIES).optional(),
  filename: t.string({ min: 1, max: 255 }).optional(),
});

export class AttachmentController {
  @action("GET", "/competitions/:cid/tasks/:tslug/attachments", {
    scope: "tasks:read",
  })
  async list(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");
    const attachments = await orm.fetchAll(
      query()
        .select(attachment)
        .where((a) => a.taskId.value().equals(value(tc.task.id)))
        .orderBy((a) => a.id.value()),
    );

    return { items: attachments.map(attachmentDto) };
  }

  @action("POST", "/competitions/:cid/tasks/:tslug/attachments", {
    scope: "tasks:write",
    maxBodySize: MAX_FILE_SIZE + 1024 * 1024,
  })
  async upload(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const tc = await loadTask(cc, ctx.params.tslug ?? "");

    const form = await ctx.formData();
    const file = form.get("file");
    const visibility = String(form.get("visibility") ?? "participants");

    if (!(file instanceof File)) {
      throw new HttpError(422, "A file is required", "file_required");
    }

    if (!(VISIBILITIES as readonly string[]).includes(visibility)) {
      throw new HttpError(
        422,
        "visibility must be participants or staff",
        "invalid_visibility",
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new HttpError(413, "Files are limited to 20 MB");
    }

    const [count] = await orm.raw<{ count: string }>(
      `SELECT COUNT(*) AS "count" FROM "attachment" WHERE "taskId" = ${lit(tc.task.id)}`,
    );

    if (Number(count?.count ?? 0) >= MAX_FILES_PER_TASK) {
      throw new HttpError(
        409,
        "A task can have at most 10 files",
        "too_many_files",
      );
    }

    const content = Buffer.from(await file.arrayBuffer());
    const storageKey = await saveFile(content);
    const [created] = await orm
      .execute(
        query().insert(attachment, {
          taskId: tc.task.id,
          filename: file.name.slice(0, 255) || "file",
          contentType: file.type || "application/octet-stream",
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          storageKey,
          visibility: visibility as (typeof VISIBILITIES)[number],
          uploadedBy: actor.id,
        }),
      )
      .catch(async (error: unknown) => {
        await deleteFile(storageKey);
        throw error;
      });

    await audit(
      cc.competition.id,
      actor,
      "attachment.uploaded",
      {
        type: "attachment",
        id: created!.id,
      },
      { task_id: tc.task.id, filename: created!.filename, visibility },
    );

    ctx.response.status = 201;
    return attachmentDto(created!);
  }

  @action("PATCH", "/competitions/:cid/attachments/:aid", {
    scope: "tasks:write",
  })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);
    const found = await findAttachment(cc, ctx.params.aid);

    const body = await ctx.validBody(updateBody);
    const [updated] = await orm.execute(
      query()
        .update(attachment, body)
        .where((a) => a.id.value().equals(value(found.id))),
    );

    return attachmentDto(updated ?? found);
  }

  @action("GET", "/competitions/:cid/attachments/:aid/download", {
    scope: "tasks:read",
  })
  async download(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const found = await findAttachment(cc, ctx.params.aid);

    ctx.download(openFile(found.storageKey), found.filename, found.contentType);
  }

  @action("DELETE", "/competitions/:cid/attachments/:aid", {
    scope: "tasks:write",
  })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const found = await findAttachment(cc, ctx.params.aid);

    await orm.execute(
      query()
        .delete(attachment)
        .where((a) => a.id.value().equals(value(found.id))),
    );
    await deleteFile(found.storageKey);

    await audit(
      cc.competition.id,
      actor,
      "attachment.deleted",
      {
        type: "attachment",
        id: found.id,
      },
      { task_id: found.taskId, filename: found.filename },
    );
  }
}

async function findAttachment(cc: CompetitionContext, aid: string | undefined) {
  const id = Number(aid);
  const competitionId = cc.competition.id;
  const found = Number.isInteger(id)
    ? await orm.fetch(
        query()
          .select(attachment)
          .where((a) =>
            a.id
              .value()
              .equals(value(id))
              .and(
                a
                  .subselect(taskModel)
                  .where((t) =>
                    t.id
                      .value()
                      .equals(a.taskId.value())
                      .and(
                        t.competitionId.value().equals(value(competitionId)),
                      ),
                  )
                  .exists(),
              ),
          ),
      )
    : null;

  if (!found) {
    throw notFound("Attachment");
  }

  return found;
}
