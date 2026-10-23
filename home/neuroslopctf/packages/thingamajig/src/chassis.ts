import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { ExecutionContextManager } from "./harness.js";
import { ConflictError, ConstraintError, ForbiddenError } from "./engine.js";
import {
  ValidationError,
  type Schema,
  type ValidationIssue,
} from "./gauge.js";
import type { ObjectLike } from "./clockwork.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Middleware<TUserResource extends ObjectLike> = (
  ctx: RequestContext<TUserResource>,
  next: () => Promise<void>,
) => Promise<void> | void;

export interface ActionOptions {
  middleware?: Middleware<any>[];
  maxBodySize?: number;
}

export type ActionHandler<TUserResource extends ObjectLike = any> = (
  ctx: RequestContext<TUserResource>,
) => unknown;

type ActionMetadata = ActionOptions & {
  method: HttpMethod;
  path: string;
};

export type Route = {
  method: HttpMethod;
  path: string;
  segments: string[];
  controller: string;
  action: string;
  handler: ActionHandler;
  middleware: Middleware<any>[];
  options: ActionOptions;
};

const actions = new WeakMap<Function, ActionMetadata>();

const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  410: "gone",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "validation_error",
  429: "rate_limited",
  500: "internal_error",
};

export class HttpError extends Error {
  readonly code: string;

  constructor(
    public readonly status: number,
    public readonly detail: string | ValidationIssue[],
    code?: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : "Validation failed");
    this.code = code ?? DEFAULT_ERROR_CODES[status] ?? "error";
  }
}

export type CookieOptions = {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export function action(
  method: HttpMethod,
  path: string,
  options: ActionOptions = {},
) {
  return function <TMethod extends (ctx: RequestContext<any>) => unknown>(
    target: TMethod,
    _context: ClassMethodDecoratorContext,
  ): void {
    actions.set(target, { ...options, method, path });
  };
}

export type WebRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
};

export type WebResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
};

export class RequestContext<TUserResource extends ObjectLike> {
  public params: Record<string, string> = {};
  public route: Route | null = null;
  public user: TUserResource | null = null;
  public readonly response: WebResponse = {
    status: 200,
    headers: {},
    body: undefined,
  };

  private bodyPromise: Promise<unknown> | null = null;
  private formDataPromise: Promise<FormData> | null = null;
  private parsedCookies: Record<string, string> | null = null;

  constructor(
    public readonly request: WebRequest,
    private raw: IncomingMessage,
    private executionContextManager: ExecutionContextManager<TUserResource>,
  ) {}

  get cookies(): Record<string, string> {
    this.parsedCookies ??= parseCookies(this.request.headers.cookie ?? "");
    return this.parsedCookies;
  }

  setCookie(name: string, value: string, options: CookieOptions = {}) {
    const existing = this.response.headers["set-cookie"];
    const cookie = serializeCookie(name, value, options);

    this.response.headers["set-cookie"] = Array.isArray(existing)
      ? [...existing, cookie]
      : existing
        ? [existing, cookie]
        : [cookie];
  }

  clearCookie(name: string, options: CookieOptions = {}) {
    this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  }

  download(
    body: Buffer | Uint8Array | Readable | ReadableStream,
    filename: string,
    contentType = "application/octet-stream",
  ) {
    this.response.headers["content-type"] = contentType;
    this.response.headers["content-disposition"] =
      contentDisposition(filename);
    this.response.body = body;
  }

  private get maxBodySize(): number {
    return this.route?.options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  }

  runAs<TResult>(user: TUserResource, callback: () => TResult): TResult {
    this.user = user;
    return this.executionContextManager.runAs(user, callback);
  }

  body<TBody = unknown>(): Promise<TBody> {
    this.bodyPromise ??= readBody(this.raw, this.maxBodySize);
    return this.bodyPromise as Promise<TBody>;
  }

  formData(): Promise<FormData> {
    this.formDataPromise ??= readFormData(this.raw, this.maxBodySize);
    return this.formDataPromise;
  }

  async validBody<TOutput>(schema: Schema<TOutput>): Promise<TOutput> {
    return schema.parse((await this.body()) ?? {}, ["body"]);
  }

  validQuery<TOutput>(schema: Schema<TOutput>): TOutput {
    const query: Record<string, string | string[]> = {};

    for (const key of new Set(this.request.query.keys())) {
      const values = this.request.query.getAll(key);
      query[key] = values.length === 1 ? values[0]! : values;
    }

    return schema.parse(query, ["query"]);
  }
}

export class Web<TUserResource extends ObjectLike> {
  private routes: Route[] = [];
  private middleware: Middleware<TUserResource>[] = [];
  private transactionRunner:
    | ((run: () => Promise<unknown>) => Promise<unknown>)
    | null = null;

  constructor(
    private executionContextManager: ExecutionContextManager<TUserResource>,
  ) {}

  use(middleware: Middleware<TUserResource>): this {
    this.middleware.push(middleware);
    return this;
  }

  transactions(
    runner: (run: () => Promise<unknown>) => Promise<unknown>,
  ): this {
    this.transactionRunner = runner;
    return this;
  }

  controller(prefix: string, controller: object): this {
    const name = controller.constructor.name;
    let added = 0;

    for (const [key, method] of controllerMethods(controller)) {
      const metadata = actions.get(method);

      if (!metadata) {
        continue;
      }

      const path = joinPaths(prefix, metadata.path);
      const segments = splitPath(path);
      const duplicate = this.routes.find(
        (route) =>
          route.method === metadata.method &&
          sameShape(route.segments, segments),
      );

      if (duplicate) {
        throw new Error(
          `${metadata.method} ${path} in ${name}.${key} conflicts with ${duplicate.controller}.${duplicate.action}`,
        );
      }

      this.routes.push({
        method: metadata.method,
        path,
        segments,
        controller: name,
        action: key,
        handler: method.bind(controller) as ActionHandler,
        middleware: metadata.middleware ?? [],
        options: metadata,
      });
      added++;
    }

    if (added === 0) {
      throw new Error(`Controller ${name} has no @action methods`);
    }

    return this;
  }

  readonly handler = (raw: IncomingMessage, res: ServerResponse) => {
    this.handle(raw, res).catch((error) => {
      console.error(error);

      if (!res.headersSent) {
        res.statusCode = 500;
      }

      res.end();
    });
  };

  listen(port: number, host?: string): Promise<Server> {
    const server = createServer(this.handler);

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  describe(): string {
    if (this.routes.length === 0) {
      return "No routes registered";
    }

    const routes = [...this.routes].sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
    const methodWidth = Math.max(...routes.map((r) => r.method.length));
    const pathWidth = Math.max(...routes.map((r) => r.path.length));

    return routes
      .map((route) => {
        const middleware =
          route.middleware.length > 0
            ? `  [+${route.middleware.length} middleware]`
            : "";

        return `${route.method.padEnd(methodWidth)}  ${route.path.padEnd(pathWidth)}  ${route.controller}.${route.action}${middleware}`;
      })
      .join("\n");
  }

  private async handle(raw: IncomingMessage, res: ServerResponse) {
    const url = new URL(raw.url ?? "/", "http://localhost");
    const ctx = new RequestContext<TUserResource>(
      {
        method: raw.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: raw.headers,
      },
      raw,
      this.executionContextManager,
    );

    const match = this.match(ctx.request.method, ctx.request.path);

    if (match) {
      ctx.route = match.route;
      ctx.params = match.params;
    }

    const layers: Middleware<TUserResource>[] = [
      ...this.middleware,
      ...(match?.route.middleware ?? []),
      async (ctx) => {
        if (!ctx.route) {
          throw this.notFound(ctx.request.method, ctx.request.path);
        }

        const route = ctx.route;
        const invoke = () => Promise.resolve(route.handler(ctx));
        const result = await (this.transactionRunner
          ? this.transactionRunner(invoke)
          : invoke());

        if (result !== undefined) {
          ctx.response.body = result;
        } else if (
          ctx.response.body === undefined &&
          ctx.response.status === 200
        ) {
          ctx.response.status = 204;
        }
      },
    ];

    await runLayers(layers, ctx);
    writeResponse(res, ctx.response);
  }

  private match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | null {
    const segments = splitPath(path);
    let best: { route: Route; params: Record<string, string> } | null = null;

    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }

      const params = matchSegments(route.segments, segments);

      if (params && (!best || specificity(route) > specificity(best.route))) {
        best = { route, params };
      }
    }

    return best;
  }

  private notFound(method: string, path: string): HttpError {
    const segments = splitPath(path);
    const allowed = this.routes
      .filter((route) => matchSegments(route.segments, segments))
      .map((route) => route.method);

    if (allowed.length > 0) {
      return new HttpError(
        405,
        `Method ${method} not allowed, use ${allowed.join(", ")}`,
        undefined,
        { allow: allowed.join(", ") },
      );
    }

    return new HttpError(404, `No route for ${method} ${path}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function serveStatic<TUserResource extends ObjectLike>(
  root: string,
  options: { exclude?: string[] } = {},
): Middleware<TUserResource> {
  const base = resolve(root);
  const exclude = options.exclude ?? [];

  return async (ctx, next) => {
    const { method, path } = ctx.request;

    if (
      method !== "GET" ||
      exclude.some(
        (prefix) => path === prefix || path.startsWith(prefix + "/"),
      )
    ) {
      return next();
    }

    const file = await resolveStaticFile(base, path);

    if (!file) {
      return next();
    }

    ctx.response.headers["content-type"] =
      CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    ctx.response.body = await readFile(file);
  };
}

async function resolveStaticFile(
  base: string,
  path: string,
): Promise<string | null> {
  const decoded = safeDecode(path);

  if (decoded === null || decoded.includes("\0")) {
    return null;
  }

  let file = resolve(base, "." + decoded);

  if (file !== base && !file.startsWith(base + sep)) {
    return null;
  }

  try {
    if ((await stat(file)).isDirectory()) {
      file = join(file, "index.html");
    }

    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function logger<TUserResource extends ObjectLike>(
  log: (line: string) => void = console.log,
): Middleware<TUserResource> {
  return async (ctx, next) => {
    const start = performance.now();

    await next();

    const duration = (performance.now() - start).toFixed(1);
    const user = ctx.user ? ` user=${JSON.stringify(ctx.user.id ?? ctx.user)}` : "";

    log(
      `${ctx.request.method} ${ctx.request.path} ${ctx.response.status} ${duration}ms${user}`,
    );
  };
}

async function runLayers<TUserResource extends ObjectLike>(
  layers: Middleware<TUserResource>[],
  ctx: RequestContext<TUserResource>,
) {
  const run = async (index: number): Promise<void> => {
    const layer = layers[index];

    if (!layer) {
      return;
    }

    try {
      await layer(ctx, () => run(index + 1));
    } catch (error) {
      applyError(ctx.response, error);
    }
  };

  await run(0);
}

function applyError(response: WebResponse, error: unknown) {
  let status: number;
  let detail: string | ValidationIssue[];
  let code: string;

  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === "content-type") {
      delete response.headers[key];
    }
  }

  if (error instanceof HttpError) {
    ({ status, detail, code } = error);
    Object.assign(response.headers, error.headers);
  } else if (error instanceof ValidationError) {
    [status, detail, code] = [422, error.issues, "validation_error"];
  } else if (error instanceof ForbiddenError) {
    [status, detail, code] = [403, error.message, "forbidden"];
  } else if (error instanceof ConflictError) {
    [status, detail, code] = [409, error.message, "conflict"];
  } else if (error instanceof ConstraintError) {
    [status, detail, code] = [422, error.message, "constraint_violation"];
  } else {
    console.error(error);
    [status, detail, code] = [500, "Internal Server Error", "internal_error"];
  }

  response.status = status;
  response.body = { detail, code };
}

function writeResponse(res: ServerResponse, response: WebResponse) {
  const { body } = response;
  let payload: string | Buffer | undefined;
  let stream: Readable | undefined;
  let contentType: string | undefined;

  if (body === undefined || body === null) {
    payload = undefined;
  } else if (body instanceof Readable || body instanceof ReadableStream) {
    stream =
      body instanceof Readable ? body : Readable.fromWeb(body as never);
    contentType = "application/octet-stream";
  } else if (body instanceof Uint8Array) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    contentType = "application/octet-stream";
  } else if (typeof body === "string") {
    payload = body;
    contentType = "text/plain; charset=utf-8";
  } else {
    payload = JSON.stringify(body);
    contentType = "application/json; charset=utf-8";
  }

  res.statusCode = response.status;

  if (contentType && !hasHeader(response.headers, "content-type")) {
    res.setHeader("Content-Type", contentType);
  }

  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }

  if (stream) {
    stream.on("error", (error) => {
      console.error(error);
      res.destroy(error);
    });
    stream.pipe(res);
  } else {
    res.end(payload);
  }
}

async function readBody(raw: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of limitBody(raw, limit)) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = raw.headers["content-type"] ?? "";

  if (text.length === 0) {
    return undefined;
  } else if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "Malformed JSON body");
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  } else {
    return text;
  }
}

async function readFormData(
  raw: IncomingMessage,
  limit: number,
): Promise<FormData> {
  const contentType = raw.headers["content-type"] ?? "";

  if (
    !contentType.includes("multipart/form-data") &&
    !contentType.includes("application/x-www-form-urlencoded")
  ) {
    throw new HttpError(
      415,
      "Expected a multipart/form-data or URL-encoded body",
    );
  }

  let tooLarge = false;
  const chunks = (async function* () {
    try {
      yield* limitBody(raw, limit);
    } catch (error) {
      tooLarge = error instanceof HttpError && error.status === 413;
      throw error;
    }
  })();

  try {
    return await new Response(ReadableStream.from(chunks), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw tooLarge
      ? new HttpError(413, "Request body too large")
      : new HttpError(400, "Malformed form data");
  }
}

async function* limitBody(
  raw: IncomingMessage,
  limit: number,
): AsyncGenerator<Buffer> {
  if (Number(raw.headers["content-length"] ?? 0) > limit) {
    throw new HttpError(413, "Request body too large");
  }

  let size = 0;

  for await (const chunk of raw as AsyncIterable<Buffer>) {
    size += chunk.length;

    if (size > limit) {
      throw new HttpError(413, "Request body too large");
    }

    yield chunk;
  }
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index <= 0) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim().replace(/^"(.*)"$/, "$1");

    cookies[name] ??= safeDecode(value) ?? value;
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? "/"}`);

  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join("; ");
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function* controllerMethods(
  controller: object,
): Generator<[string, Function]> {
  const seen = new Set<string>();

  for (
    let prototype = Object.getPrototypeOf(controller);
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);

      if (
        key === "constructor" ||
        seen.has(key) ||
        typeof descriptor?.value !== "function"
      ) {
        continue;
      }

      seen.add(key);
      yield [key, descriptor.value];
    }
  }
}

function joinPaths(prefix: string, path: string): string {
  return "/" + [...splitPath(prefix), ...splitPath(path)].join("/");
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: string[],
  segments: string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (const [index, part] of pattern.entries()) {
    const segment = segments[index]!;

    if (part.startsWith(":")) {
      const value = safeDecode(segment);

      if (value === null) {
        return null;
      }

      params[part.slice(1)] = value;
    } else if (part !== segment) {
      return null;
    }
  }

  return params;
}

function specificity(route: Route): number {
  return route.segments.filter((segment) => !segment.startsWith(":")).length;
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function sameShape(a: string[], b: string[]): boolean {
  return (
    a.length === b.length &&
    a.every((part, index) => {
      const other = b[index]!;
      return part.startsWith(":") ? other.startsWith(":") : part === other;
    })
  );
}

function hasHeader(
  headers: Record<string, string | string[]>,
  name: string,
): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
