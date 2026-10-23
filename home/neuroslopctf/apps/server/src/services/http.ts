import {
  HttpError,
  query,
  t,
  value,
  type ObjectLike,
  type RequestContext,
  type SelectExpression,
} from "@backend/thingamajig";
import { orm, type User } from "../app.js";
import { authOf } from "../auth/middleware.js";
import {
  competition as competitionModel,
  type Competition,
} from "../models/competition.js";
import {
  membership as membershipModel,
  type Membership,
} from "../models/membership.js";
import {
  competitionPermissions,
  activeRole,
  type Role,
} from "./permissions.js";

export type Ctx = RequestContext<User>;

export function currentUser(ctx: Ctx): User | null {
  return ctx.user;
}

export function requireUser(ctx: Ctx): User {
  if (!ctx.user) {
    throw new HttpError(401, "Not signed in", "not_authenticated");
  }

  return ctx.user;
}

export type CompetitionContext = {
  competition: Competition;
  membership: Membership | null;
  role: Role | null;
  permissions: string[];
  user: User | null;
};

export async function loadCompetition(ctx: Ctx): Promise<CompetitionContext> {
  const cid = ctx.params.cid ?? "";
  const competition = await orm.fetch(
    query()
      .select(competitionModel)
      .where((c) =>
        /^\d+$/.test(cid)
          ? c.id.value().equals(value(Number(cid)))
          : c.slug.value().equals(value(cid)),
      ),
  );

  if (!competition) {
    throw new HttpError(404, "Competition not found");
  }

  const auth = authOf(ctx);

  if (
    auth.kind === "token" &&
    auth.token.competitionId !== null &&
    auth.token.competitionId !== competition.id
  ) {
    throw new HttpError(
      403,
      "API token is bound to another competition",
      "token_competition_mismatch",
    );
  }

  const user = currentUser(ctx);
  const membership = user ? await membershipOf(competition.id, user.id) : null;

  return {
    competition,
    membership,
    role: activeRole(membership),
    permissions: competitionPermissions(competition, membership),
    user,
  };
}

export async function membershipOf(
  competitionId: number,
  userId: number,
): Promise<Membership | null> {
  return orm.fetch(
    query()
      .select(membershipModel)
      .where((m) =>
        m.competitionId
          .value()
          .equals(value(competitionId))
          .and(m.userId.value().equals(value(userId))),
      ),
  );
}

export function requirePermission(
  context: { permissions: string[] },
  permission: string,
  message = "You don't have permission to do this",
) {
  if (!context.permissions.includes(permission)) {
    throw new HttpError(403, message, "forbidden");
  }
}

export const pageQuery = t.object({
  limit: t.int({ min: 1, max: 200 }).default(50),
  offset: t.int({ min: 0 }).default(0),
});

export type Page<TItem> = {
  items: TItem[];
  total: number;
  limit: number;
  offset: number;
};

export async function paginate<TRow extends ObjectLike, TItem>(
  select: SelectExpression<TRow, any>,
  page: { limit: number; offset: number },
  map: (rows: TRow[]) => Promise<TItem[]> | TItem[],
): Promise<Page<TItem>> {
  const total = await orm.fetch(select.count());
  const rows = await orm.fetchAll(select.limit(page.limit).offset(page.offset));

  return { items: await map(rows), total, ...page };
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}
