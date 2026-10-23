import { HttpError, type Middleware } from "@backend/thingamajig";
import type { User } from "../app.js";

// Do not trust X-Forwarded-For from untrusted clients. A reverse proxy must
// enforce its own client-IP limits; this limiter also bounds expensive scrypt.
const windows = new Map<string, { start: number; requests: number; auth: number }>();
let active = 0;
let activeUploads = 0;
let nextPrune = 0;

export const security: Middleware<User> = async (ctx, next) => {
  Object.assign(ctx.response.headers, {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "cache-control": "no-store",
  });
  if (process.env.COOKIE_SECURE === "true") {
    ctx.response.headers["strict-transport-security"] = "max-age=31536000";
  }
  const { method, headers, path } = ctx.request;
  const upload = ctx.route?.action === "upload" && ctx.route?.controller === "AttachmentController";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site request rejected");
    if (headers.origin) {
      let sameOrigin = false;
      try {
        const origin = new URL(headers.origin);
        sameOrigin = process.env.PUBLIC_ORIGIN
          ? origin.origin === new URL(process.env.PUBLIC_ORIGIN).origin
          : ["http:", "https:"].includes(origin.protocol) && origin.host === headers.host;
      } catch { /* Invalid origins are rejected. */ }
      if (!sameOrigin) throw new HttpError(403, "Cross-origin request rejected");
    }
    const essence = (headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    const hasBody = Number(headers["content-length"] ?? 0) > 0 || headers["transfer-encoding"] !== undefined;
    if (hasBody && !["application/json", "application/x-www-form-urlencoded"].includes(essence) && !(upload && essence === "multipart/form-data")) {
      throw new HttpError(415, "Expected JSON, URL-encoded form, or multipart/form-data for uploads");
    }
  }
  const canonicalPath = "/" + path.split("/").filter(Boolean).join("/");
  if (!canonicalPath.startsWith("/api/")) return next();
  const now = Date.now();
  if (now >= nextPrune) {
    for (const [key, entry] of windows) if (now - entry.start >= 60_000) windows.delete(key);
    nextPrune = now + 60_000;
  }
  const ip = ctx.request.remoteAddress ?? "unknown";
  let entry = windows.get(ip);
  if (entry && now - entry.start >= 60_000) { windows.delete(ip); entry = undefined; }
  if (!entry) {
    if (windows.size >= 10_000) throw new HttpError(429, "Too many clients");
    entry = { start: now, requests: 0, auth: 0 };
    windows.set(ip, entry);
  }
  entry.requests++;
  const authRequest = method === "POST" && ctx.route?.controller === "AuthController" &&
      ["login", "register"].includes(ctx.route.action);
  if (authRequest) entry.auth++;
  if (entry.requests > 600 || (authRequest && entry.auth > 30)) {
    throw new HttpError(429, "Too many requests", "rate_limited", { "retry-after": "60" });
  }
  if (active >= 64 || (upload && activeUploads >= 2)) throw new HttpError(503, "Server busy");
  active++;
  if (upload) activeUploads++;
  try { await next(); } finally { active--; if (upload) activeUploads--; }
};
