import type { User } from "../app.js";
import type { Announcement } from "../models/announcement.js";
import type { ApiToken } from "../models/api-token.js";
import type { Attachment } from "../models/attachment.js";
import type { AuditEvent } from "../models/audit-event.js";
import type { Competition } from "../models/competition.js";
import type { Invite } from "../models/invite.js";
import type { JoinRequest } from "../models/join-request.js";
import type { Membership } from "../models/membership.js";
import type { Submission } from "../models/submission.js";
import type { TaskGrant } from "../models/task-grant.js";
import type { TaskRevision } from "../models/task-revision.js";
import type { Task } from "../models/task.js";
import type { TicketMessage } from "../models/ticket-message.js";
import type { Ticket } from "../models/ticket.js";


export type Viewer = {
  role: Membership["role"] | null;
  status: Membership["status"] | null;
  team_id: number | null;
  permissions: string[];
};

export function viewerOf(
  membership: Membership | null,
  permissions: string[],
): Viewer {
  return {
    role: membership?.role ?? null,
    status: membership?.status ?? null,
    team_id: membership?.teamId ?? null,
    permissions,
  };
}

export function userDto(user: User) {
  return {
    id: user.id,
    username: user.username,
    created_at: user.createdAt,
    is_instance_admin: user.isInstanceAdmin,
  };
}

export function competitionDto(
  competition: Competition,
  viewer: Viewer,
  stats: CompetitionStats,
) {
  return {
    id: competition.id,
    slug: competition.slug,
    title: competition.title,
    description: competition.description,
    owner_id: competition.ownerId,
    visibility: competition.visibility,
    join_policy: competition.joinPolicy,
    state: competition.state,
    starts_at: competition.startsAt,
    freeze_at: competition.freezeAt,
    ends_at: competition.endsAt,
    team_mode: competition.teamMode,
    team_size_max: competition.teamSizeMax,
    scoring: competition.scoring,
    created_at: competition.createdAt,
    updated_at: competition.updatedAt,
    viewer,
    stats,
  };
}

export type CompetitionStats = {
  participants: number;
  teams: number;
  tasks_published: number;
  solves: number;
  submissions: number;
};

export function competitionSummaryDto(
  competition: Competition,
  owner: { id: number; username: string },
  participants: number,
  membership: Membership | null,
) {
  return {
    id: competition.id,
    slug: competition.slug,
    title: competition.title,
    state: competition.state,
    visibility: competition.visibility,
    join_policy: competition.joinPolicy,
    starts_at: competition.startsAt,
    ends_at: competition.endsAt,
    team_mode: competition.teamMode,
    participants,
    owner,
    ...(membership
      ? { viewer: { role: membership.role, status: membership.status } }
      : {}),
  };
}

export function membershipDto(membership: Membership) {
  return {
    competition_id: membership.competitionId,
    user_id: membership.userId,
    role: membership.role,
    status: membership.status,
    invited_by: membership.invitedBy,
    team_id: membership.teamId,
    created_at: membership.createdAt,
    updated_at: membership.updatedAt,
  };
}

export function inviteDto(invite: Invite) {
  return {
    code: invite.code,
    competition_id: invite.competitionId,
    role: invite.role,
    created_by: invite.createdBy,
    max_uses: invite.maxUses,
    uses: invite.uses,
    expires_at: invite.expiresAt,
    revoked: invite.revoked,
  };
}

export function joinRequestDto(request: JoinRequest) {
  return {
    id: request.id,
    competition_id: request.competitionId,
    user_id: request.userId,
    message: request.message,
    status: request.status,
    decided_by: request.decidedBy,
    created_at: request.createdAt,
    decided_at: request.decidedAt,
  };
}

export function revisionDto(revision: TaskRevision) {
  return {
    title: revision.title,
    description: revision.description,
    category: revision.category,
    difficulty: revision.difficulty,
    base_points: revision.basePoints,
    answer_flag: revision.answerFlag,
    reward_token: revision.rewardToken,
    release_at: revision.releaseAt,
    revision: revision.revision,
    created_by: revision.createdBy,
    created_at: revision.createdAt,
  };
}

export function grantDto(grant: TaskGrant) {
  return {
    task_id: grant.taskId,
    user_id: grant.userId,
    permission: grant.permission,
    granted_by: grant.grantedBy,
    created_at: grant.createdAt,
  };
}

export function attachmentDto(attachment: Attachment) {
  return {
    id: attachment.id,
    task_id: attachment.taskId,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
    visibility: attachment.visibility,
    uploaded_by: attachment.uploadedBy,
    created_at: attachment.createdAt,
  };
}

export function submissionDto(submission: Submission) {
  return {
    id: submission.id,
    task_id: submission.taskId,
    user_id: submission.userId,
    team_id: submission.teamId,
    value: submission.value,
    correct: submission.correct,
    created_at: submission.createdAt,
  };
}

export function announcementDto(announcement: Announcement) {
  return {
    id: announcement.id,
    competition_id: announcement.competitionId,
    author_id: announcement.authorId,
    audience: announcement.audience,
    team_id: announcement.teamId,
    title: announcement.title,
    body: announcement.body,
    pinned: announcement.pinned,
    created_at: announcement.createdAt,
  };
}

export function ticketDto(ticket: Ticket) {
  return {
    id: ticket.id,
    competition_id: ticket.competitionId,
    task_id: ticket.taskId,
    opened_by: ticket.openedBy,
    team_id: ticket.teamId,
    subject: ticket.subject,
    status: ticket.status,
    visibility: ticket.visibility,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
  };
}

export function ticketMessageDto(message: TicketMessage) {
  return {
    id: message.id,
    ticket_id: message.ticketId,
    author_id: message.authorId,
    body: message.body,
    internal: message.internal,
    created_at: message.createdAt,
  };
}

export function auditDto(event: AuditEvent) {
  return {
    id: event.id,
    competition_id: event.competitionId,
    actor_id: event.actorId,
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId,
    data: event.data,
    created_at: event.createdAt,
  };
}

export function apiTokenDto(token: ApiToken) {
  return {
    id: token.id,
    user_id: token.userId,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes.split(",").filter(Boolean),
    competition_id: token.competitionId,
    created_at: token.createdAt,
    expires_at: token.expiresAt,
    last_used_at: token.lastUsedAt,
  };
}

export function taskBase(task: Task) {
  return {
    id: task.id,
    slug: task.slug,
    title: task.title,
    category: task.category,
    difficulty: task.difficulty,
  };
}
