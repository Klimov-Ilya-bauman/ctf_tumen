import {
  action,
  HttpError,
  query,
  t,
  value,
  ValidationError,
  type ContextAccessor,
  type Expression,
} from "@backend/thingamajig";
import { orm, sudo } from "../app.js";
import { competition, type Competition } from "../models/competition.js";
import { membership, type Membership } from "../models/membership.js";
import { camelKeys } from "../services/case.js";
import { audit } from "../services/audit.js";
import {
  competitionStats,
  competitionSummaries,
} from "../services/competitions.js";
import { competitionDto, viewerOf } from "../services/dto.js";
import {
  currentUser,
  loadCompetition,
  paginate,
  requirePermission,
  requireUser,
  type Ctx,
} from "../services/http.js";
import { slugify } from "../services/slug.js";
import { attachmentKeys, deleteFiles } from "../services/storage.js";

const competitionFields = {
  title: t.string({ min: 3, max: 120 }),
  description: t.string({ max: 20000 }).default(""),
  visibility: t.literal(["public", "unlisted", "private"]),
  join_policy: t.literal(["open", "invite", "approval"]),
  starts_at: t.datetime(),
  freeze_at: t.datetime().nullable().optional(),
  ends_at: t.datetime(),
  team_mode: t.boolean().default(false),
  team_size_max: t.int({ min: 1, max: 20 }).default(5),
  scoring: t.literal(["static", "dynamic"]).default("static"),
};

const createCompetition = t.object(competitionFields);
const updateCompetition = t.object(competitionFields).partial();

const listQuery = t.object({
  q: t.string({ max: 200 }).optional(),
  state: t
    .literal([
      "draft",
      "scheduled",
      "running",
      "frozen",
      "finished",
      "archived",
    ])
    .optional(),
  mine: t.literal(["owned", "joined", "staff"]).optional(),
  limit: t.int({ min: 1, max: 200 }).default(24),
  offset: t.int({ min: 0 }).default(0),
});

const stateBody = t.object({
  action: t.literal([
    "publish",
    "start",
    "freeze",
    "unfreeze",
    "finish",
    "archive",
  ]),
});

const TRANSITIONS = {
  publish: [["draft"], "scheduled"],
  start: [["scheduled"], "running"],
  freeze: [["running"], "frozen"],
  unfreeze: [["frozen"], "running"],
  finish: [["running", "frozen"], "finished"],
  archive: [["finished"], "archived"],
} as const;

export class CompetitionController {
  @action("GET", "/competitions", { scope: "competitions:read" })
  async list(ctx: Ctx) {
    const filters = ctx.validQuery(listQuery);
    const viewer = currentUser(ctx);
    const viewerId = viewer?.id ?? 0;

    const select = query()
      .select(competition)
      .where((c) =>
        c.visibility.value().equals(value("public")).or(isMember(c, viewerId)),
      )
      .orderBy((c) => c.startsAt.value(), "desc")
      .orderBy((c) => c.id.value(), "desc");

    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      select.where((c) =>
        c
          .title
          .value()
          .ilike(value(pattern))
          .or(
            c
              .subselect(competition)
              .where((d) => d.description.value().ilike(value(pattern)))
              .exists(),
          ),
      );
    }

    if (filters.state) {
      const state = filters.state;
      select.where((c) => c.state.value().equals(value(state)));
    }

    if (filters.mine === "owned") {
      select.where((c) => c.ownerId.value().equals(value(viewerId)));
    } else if (filters.mine === "joined") {
      select.where((c) => isMember(c, viewerId, ["participant", "observer"]));
    } else if (filters.mine === "staff") {
      select.where((c) =>
        isMember(c, viewerId, ["admin", "author", "reviewer"]),
      );
    }

    return paginate(select, filters, (rows) =>
      competitionSummaries(rows, viewer?.id ?? null),
    );
  }

  @action("POST", "/competitions", { scope: "competitions:write" })
  async create(ctx: Ctx) {
    const owner = requireUser(ctx);
    const body = camelKeys(await ctx.validBody(createCompetition));

    checkDates(body.startsAt, body.freezeAt ?? null, body.endsAt);

    const [created] = await orm.execute(
      query().insert(competition, {
        ...body,
        freezeAt: body.freezeAt ?? null,
        slug: slugify(body.title),
        ownerId: owner.id,
        state: "draft",
      }),
    );

    await orm.execute(
      query().insert(membership, {
        competitionId: created!.id,
        userId: owner.id,
        role: "owner",
        status: "active",
      }),
    );

    ctx.params.cid = String(created!.id);
    ctx.response.status = 201;
    return this.respond(ctx);
  }

  @action("GET", "/competitions/:cid", { scope: "competitions:read" })
  async show(ctx: Ctx) {
    return this.respond(ctx);
  }

  @action("PATCH", "/competitions/:cid", { scope: "competitions:write" })
  async update(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const body = camelKeys(await ctx.validBody(updateCompetition));
    const current = cc.competition;

    for (const [field, apiName] of [
      ["visibility", "visibility"],
      ["joinPolicy", "join_policy"],
    ] as const) {
      if (
        body[field] !== undefined &&
        body[field] !== current[field] &&
        cc.role !== "owner"
      ) {
        throw new HttpError(
          403,
          `Only the owner can change ${apiName}`,
          "owner_only",
        );
      }
    }

    const merged = {
      startsAt: body.startsAt ?? current.startsAt,
      freezeAt: body.freezeAt !== undefined ? body.freezeAt : current.freezeAt,
      endsAt: body.endsAt ?? current.endsAt,
    };

    checkDates(merged.startsAt, merged.freezeAt, merged.endsAt);

    const changes: Partial<Competition> = { ...body, updatedAt: new Date() };

    await orm.execute(
      query()
        .update(competition, changes)
        .where((c) => c.id.value().equals(value(current.id))),
    );

    await audit(
      current.id,
      actor,
      "competition.updated",
      {
        type: "competition",
        id: current.id,
      },
      { fields: Object.keys(body) },
    );

    return this.respond(ctx);
  }

  @action("DELETE", "/competitions/:cid", { scope: "competitions:write" })
  async remove(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    requireUser(ctx);

    const { confirm_slug } = await ctx.validBody(
      t.object({ confirm_slug: t.string() }),
    );

    if (confirm_slug !== cc.competition.slug) {
      throw new ValidationError([
        {
          loc: ["body", "confirm_slug"],
          msg: "Type the competition slug to confirm",
          type: "value_error",
        },
      ]);
    }

    const files = await attachmentKeys({ competitionId: cc.competition.id });

    await orm.execute(
      query()
        .delete(competition)
        .where((c) => c.id.value().equals(value(cc.competition.id))),
    );
    await deleteFiles(files);
  }

  @action("POST", "/competitions/:cid/state", { scope: "competitions:write" })
  async changeState(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    const { action: name } = await ctx.validBody(stateBody);
    const [from, to] = TRANSITIONS[name];
    const current = cc.competition;

    if (!(from as readonly string[]).includes(current.state)) {
      throw new HttpError(
        409,
        `Can't ${name} a competition in state ${current.state}`,
        "invalid_transition",
      );
    }

    const now = new Date();
    const extra =
      name === "freeze"
        ? { frozenAt: now, freezeApplied: true }
        : name === "unfreeze" || name === "finish"
          ? { frozenAt: null }
          : {};

    await orm.execute(
      query()
        .update(competition, { state: to, updatedAt: now, ...extra })
        .where((c) => c.id.value().equals(value(current.id))),
    );

    await audit(
      current.id,
      actor,
      "competition.state_changed",
      {
        type: "competition",
        id: current.id,
      },
      { action: name, from: current.state, to },
    );

    return this.respond(ctx);
  }

  @action("POST", "/competitions/:cid/transfer", {
    scope: "competitions:write",
  })
  async transfer(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const actor = requireUser(ctx);
    requirePermission(cc, "competition.transfer");

    const { user_id } = await ctx.validBody(
      t.object({ user_id: t.int({ min: 1 }) }),
    );
    const id = cc.competition.id;
    const target = await orm.fetch(
      query()
        .select(membership)
        .where((m) =>
          m.competitionId
            .value()
            .equals(value(id))
            .and(m.userId.value().equals(value(user_id))),
        ),
    );

    if (!target || target.role !== "admin" || target.status !== "active") {
      throw new HttpError(
        409,
        "Ownership can only go to an active admin",
        "invalid_transfer_target",
      );
    }

    await sudo(async () => {
      const now = new Date();
      const setRole = (userId: number, role: "owner" | "admin") =>
        orm.execute(
          query()
            .update(membership, { role, updatedAt: now })
            .where((m) =>
              m.competitionId
                .value()
                .equals(value(id))
                .and(m.userId.value().equals(value(userId))),
            ),
        );

      await setRole(actor.id, "admin");
      await setRole(user_id, "owner");
      await orm.execute(
        query()
          .update(competition, { ownerId: user_id, updatedAt: now })
          .where((c) => c.id.value().equals(value(id))),
      );
    });

    await audit(
      id,
      actor,
      "competition.transferred",
      {
        type: "competition",
        id,
      },
      { from_user_id: actor.id, to_user_id: user_id },
    );

    return this.respond(ctx);
  }

  private async respond(ctx: Ctx) {
    const cc = await loadCompetition(ctx);
    const stats = await competitionStats(cc.competition);

    return competitionDto(
      cc.competition,
      viewerOf(cc.membership, cc.permissions),
      stats,
    );
  }
}

function isMember(
  c: ContextAccessor<Competition>,
  userId: number,
  roles?: Membership["role"][],
) {
  return c
    .subselect(membership)
    .where((m) => {
      const own: Expression<boolean, any> = m.competitionId
        .value()
        .equals(c.id.value())
        .and(m.userId.value().equals(value(userId)));

      return roles
        ? own
            .and(m.role.value().in(roles))
            .and(m.status.value().equals(value("active")))
        : own;
    })
    .exists();
}

function checkDates(starts: Date, freeze: Date | null, ends: Date) {
  const issues = [];

  if (starts >= ends) {
    issues.push({
      loc: ["body", "endsAt"],
      msg: "ends_at must be after starts_at",
      type: "value_error",
    });
  }

  if (freeze && (freeze <= starts || freeze >= ends)) {
    issues.push({
      loc: ["body", "freezeAt"],
      msg: "freeze_at must be between starts_at and ends_at",
      type: "value_error",
    });
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
