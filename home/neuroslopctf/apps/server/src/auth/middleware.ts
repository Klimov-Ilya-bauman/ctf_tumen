import {
  HttpError,
  query,
  value,
  type Middleware,
  type RequestContext,
} from "@backend/thingamajig";
import { executionContext, GUEST, orm, sudo, type User } from "../app.js";
import { apiToken, type ApiToken } from "../models/api-token.js";
import { session } from "../models/session.js";
import { user } from "../models/user.js";
import { sha256 } from "./secrets.js";

export const SCOPES = [
  "competitions:read",
  "competitions:write",
  "tasks:read",
  "tasks:write",
  "submit",
  "tickets:write",
] as const;

export type Scope = (typeof SCOPES)[number];

declare module "@backend/thingamajig" {
  interface ActionOptions {
    scope?: Scope;
    sessionOnly?: boolean;
  }
}

export const SESSION_COOKIE = "neuroslopctf_session";
export const SESSION_DAYS = 7;

export type Auth =
  | { kind: "guest" }
  | { kind: "session"; token: string }
  | { kind: "token"; token: ApiToken };

const auths = new WeakMap<RequestContext<User>, Auth>();

export function authOf(ctx: RequestContext<User>): Auth {
  return auths.get(ctx) ?? { kind: "guest" };
}

function lookup<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
  return executionContext.runAs(GUEST, () => sudo(callback));
}

export const authenticate: Middleware<User> = async (ctx, next) => {
  const header = ctx.request.headers.authorization;

  if (header?.toLowerCase().startsWith("bearer ")) {
    const raw = header.slice(7).trim();
    const token = await lookup(() =>
      orm.fetch(
        query()
          .select(apiToken)
          .where((t) => t.tokenHash.value().equals(value(sha256(raw)))),
      ),
    );

    if (!token || (token.expiresAt && token.expiresAt <= new Date())) {
      throw new HttpError(401, "Invalid or expired API token", "invalid_token");
    }

    const options = ctx.route?.options;

    if (options?.sessionOnly) {
      throw new HttpError(
        403,
        "This action requires a signed-in session, not an API token",
        "session_required",
      );
    }

    if (
      ctx.route &&
      (!options?.scope || !scopesOf(token).includes(options.scope))
    ) {
      throw new HttpError(
        403,
        `API token lacks the required scope${options?.scope ? ` ${options.scope}` : ""}`,
        "insufficient_scope",
      );
    }

    const owner = await lookup(() =>
      orm.fetch(
        query()
          .select(user)
          .where((u) => u.id.value().equals(value(token.userId))),
      ),
    );

    if (!owner) {
      throw new HttpError(401, "Invalid or expired API token", "invalid_token");
    }

    await lookup(() =>
      orm.execute(
        query()
          .update(apiToken, { lastUsedAt: new Date() })
          .where((t) => t.id.value().equals(value(token.id))),
      ),
    );

    auths.set(ctx, { kind: "token", token });
    return ctx.runAs(owner, next);
  }

  const cookie = ctx.cookies[SESSION_COOKIE];

  if (cookie) {
    const found = await lookup(() =>
      orm.fetch(
        query()
          .select(session)
          .where((s) => s.token.value().equals(value(cookie))),
      ),
    );
    const owner =
      found && found.expiresAt > new Date()
        ? await lookup(() =>
            orm.fetch(
              query()
                .select(user)
                .where((u) => u.id.value().equals(value(found.userId))),
            ),
          )
        : null;

    if (owner) {
      auths.set(ctx, { kind: "session", token: cookie });
      return ctx.runAs(owner, next);
    }
  }

  auths.set(ctx, { kind: "guest" });
  return executionContext.runAs(GUEST, next);
};

export function scopesOf(token: ApiToken): Scope[] {
  return token.scopes.split(",").filter(Boolean) as Scope[];
}
