import { now, value, type ContextAccessor, type Expression } from "@backend/thingamajig";
import { competition, type Competition } from "./competition.js";
import { task, type Task } from "./task.js";


type Condition = Expression<boolean, any>;
type Roles<TName extends string> = Record<TName, Condition>;
type Subselect = { subselect: ContextAccessor<any>["subselect"] };

export function isListed(c: ContextAccessor<Competition>): Condition {
  return c.visibility
    .value()
    .in(["public", "unlisted"])
    .and(c.state.value().notEquals(value("draft")));
}

export function competitionOf(
  ctx: Subselect,
  id: Expression<number, any>,
  predicate: (c: ContextAccessor<Competition>) => Condition,
): Condition {
  return ctx
    .subselect(competition)
    .where((c) => c.id.value().equals(id).and(predicate(c)))
    .exists();
}

export function taskOf(
  ctx: Subselect,
  id: Expression<number, any>,
  predicate: (t: ContextAccessor<Task>) => Condition,
): Condition {
  return ctx
    .subselect(task)
    .where((t) => t.id.value().equals(id).and(predicate(t)))
    .exists();
}

export function canReadTaskSecrets(
  roles: Roles<"reviewer" | "staff" | "viewer">,
) {
  return roles.reviewer.or(roles.staff.and(roles.viewer));
}

export function canReadTask(
  roles: Roles<"reviewer" | "staff" | "viewer" | "player">,
  onTask: (predicate: (t: ContextAccessor<Task>) => Condition) => Condition,
) {
  const released = (t: ContextAccessor<Task>) =>
    t.state
      .value()
      .equals(value("published"))
      .and(
        t.releaseAt
          .value()
          .isNull()
          .or(t.releaseAt.value().compare("<=", now())),
      );

  return canReadTaskSecrets(roles)
    .or(
      roles.staff.or(roles.player).and(
        onTask((t) =>
          released(t).and(
            competitionOf(t, t.competitionId.value(), (c) =>
              c.state.value().in(["running", "frozen", "finished", "archived"]),
            ),
          ),
        ),
      ),
    )
    .or(
      onTask((t) =>
        released(t).and(
          competitionOf(t, t.competitionId.value(), (c) =>
            c.visibility
              .value()
              .equals(value("public"))
              .and(c.state.value().in(["finished", "archived"])),
          ),
        ),
      ),
    );
}

export function canEditTask(roles: Roles<"staff" | "editor">) {
  return roles.staff.and(roles.editor);
}

export function canManageTask(roles: Roles<"staff" | "manager">) {
  return roles.staff.and(roles.manager);
}

export function canPlay(
  ctx: Subselect & {
    roles: Roles<"participant">;
    competitionId: { value(): Expression<number, any> };
  },
) {
  return ctx.roles.participant.and(
    competitionOf(ctx, ctx.competitionId.value(), (c) =>
      c.state.value().in(["running", "frozen"]),
    ),
  );
}

export function canAnswerTicket(roles: Roles<"admin" | "staff" | "handler">) {
  return roles.admin.or(roles.staff.and(roles.handler));
}

export function canReadTicket(
  roles: Roles<
    "admin" | "staff" | "player" | "handler" | "opener" | "teammate"
  >,
  isPublic: Condition,
) {
  return canAnswerTicket(roles)
    .or(roles.opener)
    .or(roles.teammate)
    .or(isPublic.and(roles.staff.or(roles.player)));
}
