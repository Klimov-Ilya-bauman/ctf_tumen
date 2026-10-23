
CREATE TABLE "user" (
  "id" serial PRIMARY KEY,
  "username" text NOT NULL,
  "passwordHash" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "isInstanceAdmin" boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "user_username_key" ON "user" (lower("username"));

CREATE TABLE "session" (
  "token" text PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL
);

CREATE TABLE "competition" (
  "id" serial PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "ownerId" integer NOT NULL REFERENCES "user" ("id"),
  "visibility" text NOT NULL CHECK ("visibility" IN ('public', 'unlisted', 'private')),
  "joinPolicy" text NOT NULL CHECK ("joinPolicy" IN ('open', 'invite', 'approval')),
  "state" text NOT NULL DEFAULT 'draft'
    CHECK ("state" IN ('draft', 'scheduled', 'running', 'frozen', 'finished', 'archived')),
  "startsAt" timestamptz NOT NULL,
  "freezeAt" timestamptz,
  "endsAt" timestamptz NOT NULL,
  "freezeApplied" boolean NOT NULL DEFAULT false,
  "frozenAt" timestamptz,
  "teamMode" boolean NOT NULL DEFAULT false,
  "teamSizeMax" integer NOT NULL DEFAULT 5 CHECK ("teamSizeMax" BETWEEN 1 AND 20),
  "scoring" text NOT NULL DEFAULT 'static' CHECK ("scoring" IN ('static', 'dynamic')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "api_token" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE,
  "prefix" text NOT NULL,
  "scopes" text NOT NULL,
  "competitionId" integer REFERENCES "competition" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,
  "lastUsedAt" timestamptz
);

CREATE TABLE "team" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "captainId" integer NOT NULL REFERENCES "user" ("id"),
  "joinCode" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "team_name_key" ON "team" ("competitionId", lower("name"));

CREATE TABLE "membership" (
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" text NOT NULL
    CHECK ("role" IN ('owner', 'admin', 'author', 'reviewer', 'participant', 'observer')),
  "status" text NOT NULL CHECK ("status" IN ('invited', 'pending', 'active', 'banned')),
  "invitedBy" integer REFERENCES "user" ("id"),
  "teamId" integer REFERENCES "team" ("id") ON DELETE SET NULL,
  "teamJoinedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("competitionId", "userId")
);

CREATE TABLE "competition_pin" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "competitionId")
);

CREATE TABLE "invite" (
  "code" text PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('admin', 'author', 'reviewer', 'participant', 'observer')),
  "createdBy" integer NOT NULL REFERENCES "user" ("id"),
  "maxUses" integer CHECK ("maxUses" > 0),
  "uses" integer NOT NULL DEFAULT 0,
  "expiresAt" timestamptz,
  "revoked" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "join_request" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "message" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "decidedBy" integer REFERENCES "user" ("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "decidedAt" timestamptz
);

CREATE TABLE "task" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "authorId" integer NOT NULL REFERENCES "user" ("id"),
  "title" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "difficulty" text NOT NULL CHECK ("difficulty" IN ('easy', 'medium', 'hard')),
  "basePoints" integer NOT NULL CHECK ("basePoints" >= 0),
  "answerFlag" text NOT NULL,
  "rewardToken" text NOT NULL,
  "state" text NOT NULL DEFAULT 'draft'
    CHECK ("state" IN ('draft', 'review', 'published', 'hidden', 'archived')),
  "releaseAt" timestamptz,
  "maxSolves" integer CHECK ("maxSolves" > 0),
  "revision" integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("competitionId", "slug")
);

CREATE TABLE "task_grant" (
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "permission" text NOT NULL CHECK ("permission" IN ('view', 'edit', 'manage')),
  "grantedBy" integer NOT NULL REFERENCES "user" ("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "userId")
);

CREATE TABLE "task_revision" (
  "id" serial PRIMARY KEY,
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "difficulty" text NOT NULL,
  "basePoints" integer NOT NULL,
  "answerFlag" text NOT NULL,
  "rewardToken" text NOT NULL,
  "releaseAt" timestamptz,
  "createdBy" integer NOT NULL REFERENCES "user" ("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("taskId", "revision")
);

CREATE TABLE "attachment" (
  "id" serial PRIMARY KEY,
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "contentType" text NOT NULL,
  "size" integer NOT NULL,
  "sha256" text NOT NULL,
  "storageKey" text NOT NULL,
  "visibility" text NOT NULL CHECK ("visibility" IN ('participants', 'staff')),
  "uploadedBy" integer NOT NULL REFERENCES "user" ("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "hint" (
  "id" serial PRIMARY KEY,
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "order" integer NOT NULL,
  "body" text NOT NULL,
  "cost" integer NOT NULL CHECK ("cost" >= 0)
);

CREATE TABLE "hint_unlock" (
  "hintId" integer NOT NULL REFERENCES "hint" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "teamId" integer REFERENCES "team" ("id") ON DELETE SET NULL,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "cost" integer NOT NULL,
  "unlockedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("hintId", "userId")
);

CREATE TABLE "submission" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "teamId" integer REFERENCES "team" ("id") ON DELETE SET NULL,
  "value" text NOT NULL,
  "correct" boolean NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "submission_rate_idx" ON "submission" ("taskId", "userId", "createdAt");

CREATE TABLE "solve" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "taskId" integer NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "teamId" integer REFERENCES "team" ("id") ON DELETE SET NULL,
  "submissionId" integer NOT NULL REFERENCES "submission" ("id") ON DELETE CASCADE,
  "pointsAwarded" integer NOT NULL,
  "solvedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("taskId", "userId")
);
CREATE UNIQUE INDEX "solve_team_key" ON "solve" ("taskId", "teamId") WHERE "teamId" IS NOT NULL;

CREATE TABLE "announcement" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "authorId" integer NOT NULL REFERENCES "user" ("id"),
  "audience" text NOT NULL CHECK ("audience" IN ('all', 'staff', 'team')),
  "teamId" integer REFERENCES "team" ("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "pinned" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "ticket" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "taskId" integer REFERENCES "task" ("id") ON DELETE SET NULL,
  "openedBy" integer NOT NULL REFERENCES "user" ("id"),
  "teamId" integer REFERENCES "team" ("id") ON DELETE SET NULL,
  "subject" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'answered', 'closed')),
  "visibility" text NOT NULL DEFAULT 'private' CHECK ("visibility" IN ('private', 'public')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "ticket_message" (
  "id" serial PRIMARY KEY,
  "ticketId" integer NOT NULL REFERENCES "ticket" ("id") ON DELETE CASCADE,
  "authorId" integer NOT NULL REFERENCES "user" ("id"),
  "body" text NOT NULL,
  "internal" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "audit_event" (
  "id" serial PRIMARY KEY,
  "competitionId" integer NOT NULL REFERENCES "competition" ("id") ON DELETE CASCADE,
  "actorId" integer NOT NULL REFERENCES "user" ("id"),
  "action" text NOT NULL,
  "targetType" text NOT NULL,
  "targetId" integer NOT NULL,
  "data" jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
