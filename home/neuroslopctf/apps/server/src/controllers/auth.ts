import { action, HttpError, query, t, value } from "@backend/thingamajig";
import { orm, sudo, type User } from "../app.js";
import { authOf, SESSION_COOKIE, SESSION_DAYS } from "../auth/middleware.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { randomToken } from "../auth/secrets.js";
import { session } from "../models/session.js";
import { user } from "../models/user.js";
import { userDto } from "../services/dto.js";
import { requireUser, type Ctx } from "../services/http.js";
import { lit } from "../services/sql.js";

const credentials = t.object({
  username: t.string({ min: 3, max: 40, pattern: /^\S+$/ }),
  password: t.string({ min: 6, max: 200 }),
});

export class AuthController {
  @action("POST", "/auth/register")
  async register(ctx: Ctx) {
    const body = await ctx.validBody(credentials);
    const [created] = await sudo(async () =>
      orm.execute(
        query().insert(user, {
          username: body.username,
          passwordHash: await hashPassword(body.password),
        }),
      ),
    );

    await startSession(ctx, created!);
    ctx.response.status = 201;
    return userDto(created!);
  }

  @action("POST", "/auth/login")
  async login(ctx: Ctx) {
    const body = await ctx.validBody(credentials);
    const [found] = await orm.raw<User>(
      `SELECT * FROM "user" WHERE lower("username") = lower(${lit(body.username)})`,
    );

    if (!found || !(await verifyPassword(body.password, found.passwordHash))) {
      throw new HttpError(
        401,
        "Wrong username or password",
        "invalid_credentials",
      );
    }

    await startSession(ctx, found);
    return userDto(found);
  }

  @action("POST", "/auth/logout")
  async logout(ctx: Ctx) {
    const auth = authOf(ctx);

    if (auth.kind === "session") {
      await orm.execute(
        query()
          .delete(session)
          .where((s) => s.token.value().equals(value(auth.token))),
      );
    }

    ctx.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }

  @action("GET", "/auth/me")
  async me(ctx: Ctx) {
    const current = requireUser(ctx);
    const [counts] = await orm.raw<{ owned: string; joined: string }>(`
        SELECT
          (SELECT COUNT(*) FROM "competition" WHERE "ownerId" = ${lit(current.id)}) AS "owned",
          (SELECT COUNT(*) FROM "membership" WHERE "userId" = ${lit(current.id)}
            AND "role" IN ('participant', 'observer')) AS "joined"`);

    return {
      ...userDto(current),
      competitions_owned: Number(counts?.owned ?? 0),
      competitions_joined: Number(counts?.joined ?? 0),
    };
  }
}

async function startSession(ctx: Ctx, owner: User) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);

  await sudo(() =>
    orm.execute(
      query().insert(session, {
        token,
        userId: owner.id,
        expiresAt: expires,
      }),
    ),
  );

  ctx.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 24 * 3600,
    expires,
  });
}
