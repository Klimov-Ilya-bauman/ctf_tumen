import type { User } from "../app.js";
import type { Competition } from "../models/competition.js";
import type { Membership } from "../models/membership.js";
import type { Task } from "../models/task.js";


export type Role = Membership["role"];

export const ROLE_RANK: Record<Role, number> = {
  owner: 5,
  admin: 4,
  author: 3,
  reviewer: 3,
  participant: 2,
  observer: 1,
};

const STAFF_ROLES: Role[] = ["owner", "admin", "author", "reviewer"];

export function activeRole(membership: Membership | null): Role | null {
  return membership?.status === "active" ? membership.role : null;
}

export function isStaffRole(role: Role | null): boolean {
  return role !== null && STAFF_ROLES.includes(role);
}

export function isRunningOrLater(competition: Competition): boolean {
  return ["running", "frozen", "finished", "archived"].includes(
    competition.state,
  );
}

export function isPlayable(competition: Competition): boolean {
  return competition.state === "running" || competition.state === "frozen";
}

export function competitionPermissions(
  competition: Competition,
  membership: Membership | null,
): string[] {
  const role = activeRole(membership);
  const owner = role === "owner";
  const admin = owner || role === "admin";
  const staff = isStaffRole(role);
  const player = role === "participant" || role === "observer";
  const visible =
    membership !== null ||
    (competition.visibility !== "private" && competition.state !== "draft");
  const publicFinished =
    competition.visibility === "public" &&
    (competition.state === "finished" || competition.state === "archived");

  const granted: [string, boolean][] = [
    ["competition.view", visible],
    ["competition.edit", admin],
    ["competition.state", admin],
    ["competition.delete", owner],
    ["competition.transfer", owner],
    ["admins.manage", owner],
    ["members.view", role !== null],
    ["members.manage", admin],
    ["invites.manage", admin],
    ["requests.manage", admin],
    ["tasks.create", admin || role === "author"],
    ["tasks.view_all", staff],
    ["tasks.manage_any", admin],
    ["tasks.review", admin || role === "reviewer"],
    [
      "play.view_tasks",
      staff ||
        (player && isRunningOrLater(competition)) ||
        (membership === null && publicFinished),
    ],
    ["play.submit", role === "participant" && isPlayable(competition)],
    ["play.unlock_hint", role === "participant" && isPlayable(competition)],
    ["submissions.view_all", admin || role === "author"],
    [
      "tickets.create",
      membership?.role === "participant" &&
        (membership.status === "active" || membership.status === "banned"),
    ],
    ["tickets.view_all", admin || role === "author"],
    ["tickets.answer", admin || role === "author"],
    ["announcements.manage", admin],
    ["scoreboard.live", staff],
    ["audit.view", admin],
    ["teams.manage", admin],
  ];

  return granted.filter(([, allowed]) => allowed).map(([name]) => name);
}

const ALL_TASK_PERMISSIONS = [
  "task.view",
  "task.view_secrets",
  "task.edit",
  "task.delete",
  "task.publish",
  "task.review",
  "task.grant",
  "task.attach",
  "task.view_submissions",
];

export function taskPermissions(
  competition: Competition,
  membership: Membership | null,
  user: User | null,
  task: Task,
  grant: "view" | "edit" | "manage" | null,
): string[] {
  const role = activeRole(membership);

  if (role === "owner" || role === "admin") {
    return [...ALL_TASK_PERMISSIONS];
  }

  const permissions = new Set<string>();
  const staff = isStaffRole(role);

  if (staff && (task.authorId === user?.id || grant === "manage")) {
    for (const permission of ALL_TASK_PERMISSIONS) {
      if (permission !== "task.publish" && permission !== "task.review") {
        permissions.add(permission);
      }
    }
  }

  if (staff && grant === "edit") {
    ["task.view", "task.view_secrets", "task.edit", "task.attach"].forEach(
      (permission) => permissions.add(permission),
    );
  }

  if (staff && grant === "view") {
    ["task.view", "task.view_secrets"].forEach((permission) =>
      permissions.add(permission),
    );
  }

  if (role === "reviewer") {
    ["task.view", "task.view_secrets", "task.review"].forEach((permission) =>
      permissions.add(permission),
    );
  }

  const released =
    task.state === "published" &&
    (task.releaseAt === null || task.releaseAt.getTime() <= Date.now());
  const publicFinished =
    competition.visibility === "public" &&
    (competition.state === "finished" || competition.state === "archived");

  if (
    released &&
    isRunningOrLater(competition) &&
    (staff ||
      role === "participant" ||
      role === "observer" ||
      (membership === null && publicFinished))
  ) {
    permissions.add("task.view");
  }

  return ALL_TASK_PERMISSIONS.filter((permission) =>
    permissions.has(permission),
  );
}

export function grantableRoles(role: Role | null): Role[] {
  if (role === "owner") {
    return ["admin", "author", "reviewer", "participant", "observer"];
  }

  if (role === "admin") {
    return ["author", "reviewer", "participant", "observer"];
  }

  return [];
}

export function canManageMember(
  viewer: Role | null,
  target: Membership,
): boolean {
  if (viewer === "owner") {
    return target.role !== "owner";
  }

  return viewer === "admin" && ROLE_RANK[target.role] < ROLE_RANK.admin;
}
