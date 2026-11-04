import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginId,
} from "@t3tools/contracts";
import type { PluginHttpRequest, PluginHttpResponse } from "@t3tools/plugin-sdk/server";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateRawRouteWithScope } from "../http.ts";
import { abortEffect, errorText } from "./api/facade.ts";

const ROUTE_PREFIX = "/api/plugins";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
type PluginHttpMethod = (typeof METHODS)[number];
// The caller's credentials stay with the server; a plugin that logs headers cannot leak them.
const WITHHELD_HEADERS = new Set(["authorization", "cookie", "dpop"]);

const isMethod = Schema.is(Schema.Literals(METHODS));
// Plugins are untyped JavaScript, so their responses are checked before they reach the socket.
const isPluginResponse = Schema.is(
  Schema.Struct({
    status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 }))),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.optional(Schema.Union([Schema.String, Schema.Uint8Array])),
  }),
);

export class PluginHttpRouteInvalidError extends Schema.TaggedError<PluginHttpRouteInvalidError>()(
  "PluginHttpRouteInvalidError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Routes need method GET, POST, PUT or DELETE and a path that starts with "/" and has no "?", "#" or spaces.`;
  }
}
export const isPluginHttpRouteInvalidError = Schema.is(PluginHttpRouteInvalidError);

export class PluginHttpRouteNotFoundError extends Schema.TaggedError<PluginHttpRouteNotFoundError>()(
  "PluginHttpRouteNotFoundError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no route for this request.`;
  }
}

// `reason` is the plugin's own error text, bounded; it goes to the log, not the response.
export class PluginHttpHandlerError extends Schema.TaggedError<PluginHttpHandlerError>()(
  "PluginHttpHandlerError",
  { pluginId: Schema.String, reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed to handle the request.`;
  }
}

type PluginHttpRouteHandler = (
  request: PluginHttpRequest,
  signal: AbortSignal,
) => Promise<PluginHttpResponse>;

interface PluginHttpRoute {
  readonly handler: PluginHttpRouteHandler;
  readonly deactivated: AbortSignal | undefined;
}

export class PluginHttpRoutes extends Context.Service<
  PluginHttpRoutes,
  {
    /**
     * Serves `method path` under `/api/plugins/<pluginId>`, replacing a route of that method and
     * path. A path ending in `/*` answers every path below it; the longest match wins.
     */
    readonly register: (input: {
      readonly pluginId: PluginId;
      readonly method: PluginHttpMethod;
      readonly path: string;
      /** `signal` aborts when the client goes away. */
      readonly handler: PluginHttpRouteHandler;
      /** Aborts when the plugin turns off; a request still running then gets a 404. */
      readonly deactivated?: AbortSignal;
    }) => Effect.Effect<void, PluginHttpRouteInvalidError>;
    readonly unregisterPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /** Answers a request already signed in and read; `path` is the part after the plugin id. */
    readonly handle: (input: {
      readonly pluginId: string;
      readonly request: PluginHttpRequest;
    }) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      PluginHttpRouteNotFoundError | PluginHttpHandlerError
    >;
  }
>()("t3/plugins/PluginHttpRoutes") {}

const isValidPath = (path: string) =>
  path.startsWith("/") && path.length <= MAX_PATH_CHARS && !/[?#\s]/.test(path);

const findRoute = (
  pluginRoutes: ReadonlyMap<string, PluginHttpRoute> | undefined,
  method: string,
  path: string,
) => {
  if (pluginRoutes === undefined) return undefined;
  const exact = pluginRoutes.get(`${method} ${path}`);
  if (exact !== undefined) return exact;
  // Paths start with "/", so the walk ends at index 0 with the `/*` catch-all.
  for (let end = path.lastIndexOf("/"); end >= 0; end = path.lastIndexOf("/", end - 1)) {
    const prefixed = pluginRoutes.get(`${method} ${path.slice(0, end)}/*`);
    if (prefixed !== undefined) return prefixed;
    if (end === 0) break;
  }
  return undefined;
};

const make = () => {
  // pluginId -> "METHOD /path" -> route
  const routes = new Map<string, Map<string, PluginHttpRoute>>();
  return PluginHttpRoutes.of({
    register: Effect.fn("PluginHttpRoutes.register")(function* ({
      pluginId,
      method,
      path,
      handler,
      deactivated,
    }) {
      if (!isMethod(method) || !isValidPath(path)) {
        return yield* new PluginHttpRouteInvalidError({ pluginId });
      }
      const pluginRoutes = routes.get(pluginId) ?? new Map();
      routes.set(pluginId, pluginRoutes.set(`${method} ${path}`, { handler, deactivated }));
    }),
    unregisterPlugin: Effect.fn("PluginHttpRoutes.unregisterPlugin")((pluginId) =>
      Effect.sync(() => {
        routes.delete(pluginId);
      }),
    ),
    handle: Effect.fn("PluginHttpRoutes.handle")(function* ({ pluginId, request }) {
      const route = findRoute(routes.get(pluginId), request.method, request.path);
      if (route === undefined) {
        return yield* new PluginHttpRouteNotFoundError({ pluginId });
      }
      const failed = (cause: unknown) =>
        new PluginHttpHandlerError({ pluginId, reason: errorText(cause), cause });
      const handled = Effect.tryPromise({
        try: (signal) => route.handler(request, signal),
        catch: failed,
      });
      // A handler that ignores its abort signal must not hold the request open after disable.
      const response: unknown = yield* route.deactivated === undefined
        ? handled
        : Effect.raceFirst(
            handled,
            abortEffect(route.deactivated).pipe(
              Effect.andThen(Effect.fail(new PluginHttpRouteNotFoundError({ pluginId }))),
            ),
          );
      if (!isPluginResponse(response)) {
        return yield* failed(new TypeError("The handler returned an invalid response."));
      }
      const { body, ...options } = response;
      const withStatus = { ...options, status: options.status ?? 200 };
      return body === undefined
        ? HttpServerResponse.empty(withStatus)
        : typeof body === "string"
          ? HttpServerResponse.text(body, withStatus)
          : HttpServerResponse.uint8Array(body, withStatus);
    }),
  });
};

export const layer = Layer.sync(PluginHttpRoutes, make);

/** Same sign-in as the rest of `/api`: reads need `orchestration:read`, everything else operate. */
const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
  authenticateRawRouteWithScope(
    request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
  );

const tooLarge = HttpServerResponse.text("The request body is over 1 MiB.", { status: 413 });

/** `/api/plugins/<pluginId>/<path>`, answered by the route the plugin registered. */
export const layerRoute = HttpRouter.add(
  "*",
  `${ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* authenticate(request);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const rest = url.value.pathname.slice(`${ROUTE_PREFIX}/`.length);
    const slash = rest.indexOf("/");
    const pluginId = slash === -1 ? rest : rest.slice(0, slash);
    if (Number(request.headers["content-length"] ?? "0") > MAX_BODY_BYTES) return tooLarge;
    const body = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.option,
    );
    if (Option.isNone(body)) return tooLarge;
    const routes = yield* PluginHttpRoutes;
    return yield* routes.handle({
      pluginId,
      request: {
        method: request.method,
        path: slash === -1 ? "/" : rest.slice(slash),
        query: Object.fromEntries(url.value.searchParams),
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !WITHHELD_HEADERS.has(name)),
        ),
        body: body.value,
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      PluginHttpRouteNotFoundError: () =>
        Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
      PluginHttpHandlerError: (error) =>
        Effect.logWarning("plugin http handler failed", {
          pluginId: error.pluginId,
          reason: error.reason,
        }).pipe(Effect.as(HttpServerResponse.text(error.message, { status: 500 }))),
    }),
  ),
);
