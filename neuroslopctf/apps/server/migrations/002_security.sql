-- Raw session tokens were historically persisted and may have been exposed.
-- Revoke them on upgrade instead of keeping legacy bearer credentials valid.
DELETE FROM "session";

-- A hint is purchased once per team, not once per teammate. Keep the earliest
-- historical purchase, removing accidental duplicate charges before indexing.
DELETE FROM "hint_unlock" a USING "hint_unlock" b
WHERE a."teamId" IS NOT NULL AND a."teamId" = b."teamId"
  AND a."hintId" = b."hintId"
  AND (a."unlockedAt", a."userId") > (b."unlockedAt", b."userId");
-- Personal and team purchases have different ownership. A former teammate
-- buying the hint for another team must not hit a stale (hintId,userId) key.
ALTER TABLE "hint_unlock" DROP CONSTRAINT "hint_unlock_pkey";
ALTER TABLE "hint_unlock" ADD COLUMN "id" bigserial PRIMARY KEY;
ALTER TABLE "hint_unlock" DROP CONSTRAINT "hint_unlock_teamId_fkey";
ALTER TABLE "hint_unlock" ADD CONSTRAINT "hint_unlock_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "team" ("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "hint_unlock_user_key" ON "hint_unlock" ("hintId", "userId")
  WHERE "teamId" IS NULL;
CREATE UNIQUE INDEX "hint_unlock_team_key" ON "hint_unlock" ("hintId", "teamId")
  WHERE "teamId" IS NOT NULL;

CREATE INDEX "membership_user_competition_idx" ON "membership" ("userId", "competitionId");
CREATE INDEX "membership_team_idx" ON "membership" ("teamId") WHERE "teamId" IS NOT NULL;
CREATE INDEX "session_expiry_idx" ON "session" ("expiresAt");
