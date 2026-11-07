import { AuthOrchestrationReadScope, PluginId } from "@t3tools/contracts";
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

import { authenticateRawRouteWithScope } from "../http.ts";

const ROUTE_PREFIX = "/api/plugins";

/** A GET request for a plugin's files; `path` is the part after the plugin id. */
interface PluginHttpRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

interface PluginHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

export class PluginHttpRouteNotFoundError extends Schema.TaggedError<PluginHttpRouteNotFoundError>()(
  "PluginHttpRouteNotFoundError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has no route for this request.`;
  }
}

type PluginHttpRouteHandler = (request: PluginHttpRequest) => Promise<PluginHttpResponse>;

export class PluginHttpRoutes extends Context.Service<
  PluginHttpRoutes,
  {
    /**
     * Serves GET `path` under `/api/plugins/<pluginId>`, replacing a route of that path. A path
     * ending in `/*` answers every path below it; the longest match wins.
     */
    readonly register: (input: {
      readonly pluginId: PluginId;
      readonly path: string;
      readonly handler: PluginHttpRouteHandler;
    }) => Effect.Effect<void>;
    readonly unregisterPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /** Answers a request already signed in. */
    readonly handle: (input: {
      readonly pluginId: string;
      readonly request: PluginHttpRequest;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse, PluginHttpRouteNotFoundError>;
  }
>()("t3/plugins/PluginHttpRoutes") {}

const findRoute = (
  pluginRoutes: ReadonlyMap<string, PluginHttpRouteHandler> | undefined,
  path: string,
) => {
  if (pluginRoutes === undefined) return undefined;
  const exact = pluginRoutes.get(path);
  if (exact !== undefined) return exact;
  // Paths start with "/", so the walk ends at index 0 with the `/*` catch-all.
  for (let end = path.lastIndexOf("/"); end >= 0; end = path.lastIndexOf("/", end - 1)) {
    const prefixed = pluginRoutes.get(`${path.slice(0, end)}/*`);
    if (prefixed !== undefined) return prefixed;
    if (end === 0) break;
  }
  return undefined;
};

const make = () => {
  // pluginId -> path -> handler
  const routes = new Map<string, Map<string, PluginHttpRouteHandler>>();
  return PluginHttpRoutes.of({
    register: Effect.fn("PluginHttpRoutes.register")(({ pluginId, path, handler }) =>
      Effect.sync(() => {
        const pluginRoutes = routes.get(pluginId) ?? new Map();
        routes.set(pluginId, pluginRoutes.set(path, handler));
      }),
    ),
    unregisterPlugin: Effect.fn("PluginHttpRoutes.unregisterPlugin")((pluginId) =>
      Effect.sync(() => {
        routes.delete(pluginId);
      }),
    ),
    handle: Effect.fn("PluginHttpRoutes.handle")(function* ({ pluginId, request }) {
      const handler = findRoute(routes.get(pluginId), request.path);
      if (handler === undefined) {
        return yield* new PluginHttpRouteNotFoundError({ pluginId });
      }
      const { body, ...options } = yield* Effect.promise(() => handler(request));
      return typeof body === "string"
        ? HttpServerResponse.text(body, options)
        : HttpServerResponse.uint8Array(body, options);
    }),
  });
};

export const layer = Layer.sync(PluginHttpRoutes, make);

/** `/api/plugins/<pluginId>/<path>`, answered by the route the host registered for the plugin. */
export const layerRoute = HttpRouter.add(
  "GET",
  `${ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Same sign-in as reads on the rest of `/api`.
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const rest = url.value.pathname.slice(`${ROUTE_PREFIX}/`.length);
    const slash = rest.indexOf("/");
    const pluginId = slash === -1 ? rest : rest.slice(0, slash);
    const routes = yield* PluginHttpRoutes;
    return yield* routes.handle({
      pluginId,
      request: {
        path: slash === -1 ? "/" : rest.slice(slash),
        query: Object.fromEntries(url.value.searchParams),
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      PluginHttpRouteNotFoundError: () =>
        Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
    }),
  ),
);
