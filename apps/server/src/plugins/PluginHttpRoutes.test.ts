import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  PluginId,
} from "@t3tools/contracts";
import type { PluginApi, PluginDefinition } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeFacadeContext } from "./api/facade.ts";
import { makeHttpApi } from "./api/http.ts";
import { makePluginActivation, type PluginPublication } from "./PluginApi.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";

const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const httpPlugin = PluginId.make("http-plugin");

const scopesByToken: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer read": [AuthOrchestrationReadScope],
  "Bearer operate": [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) => {
    const scopes = scopesByToken[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session"),
          subject: "test",
          method: "bearer-access-token",
          scopes,
        });
  },
});

const isDefinition = (value: unknown): value is PluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

/** Serves the route with the fixture activated through the `http` group, the one it uses. */
const serveFixture = Effect.fn(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(PluginHttpRoutes.layerRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(PluginHttpRoutes.layer),
      Layer.provideMerge(layerAuth),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const loaded: unknown = yield* Effect.promise(
    () => import(`${fixturesDir}http-plugin/server.cjs`),
  );
  const definition =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  assert(isDefinition(definition));
  const facade = makeFacadeContext({
    pluginId: httpPlugin,
    activation: makePluginActivation(yield* PubSub.sliding<PluginPublication>(1)),
    context: yield* Effect.context<never>(),
  });
  const routes = Context.get(services, PluginHttpRoutes.PluginHttpRoutes);
  const api: Pick<PluginApi, "http"> = { http: makeHttpApi(facade, { httpRoutes: routes }) };
  yield* Effect.promise(() => Promise.resolve(definition.activate(api as PluginApi)));
  const client = Context.get(services, HttpClient.HttpClient);
  const send = Effect.fn(function* (
    method: "GET" | "POST",
    path: string,
    options: { readonly token?: string; readonly body?: string } = {},
  ) {
    const response = yield* client.execute(
      HttpClientRequest.make(method)(path).pipe(
        options.token === undefined
          ? (request) => request
          : HttpClientRequest.setHeader("authorization", options.token),
        options.body === undefined
          ? (request) => request
          : HttpClientRequest.bodyText(options.body, "application/json"),
      ),
    );
    return {
      status: response.status,
      contentType: response.headers["content-type"],
      body: yield* response.text,
    };
  });
  return { api, routes, send };
});

it.effect("serves a plugin's routes and answers 404 and 500 for the rest", () =>
  Effect.gen(function* () {
    const { api, routes, send } = yield* serveFixture();
    api.http.route("GET", "/fail", () => {
      throw new Error("boom");
    });
    api.http.route("GET", "/files/*", (request) => ({ body: `any ${request.path}` }));
    api.http.route("GET", "/files/deep/*", (request) => ({ body: `deep ${request.path}` }));

    assert.deepStrictEqual(
      yield* send("GET", "/api/plugins/http-plugin/hello?name=ash", { token: "Bearer read" }),
      { status: 200, contentType: "text/plain", body: "hello ash" },
    );
    assert.deepStrictEqual(
      yield* send("POST", "/api/plugins/http-plugin/echo", {
        token: "Bearer operate",
        body: '{"ping":1}',
      }),
      { status: 201, contentType: "application/json", body: '{"ping":1}' },
    );
    assert.strictEqual(
      (yield* send("GET", "/api/plugins/http-plugin/files/a/b.txt", { token: "Bearer read" })).body,
      "any /files/a/b.txt",
    );
    assert.strictEqual(
      (yield* send("GET", "/api/plugins/http-plugin/files/deep/c.txt", { token: "Bearer read" }))
        .body,
      "deep /files/deep/c.txt",
    );
    assert.strictEqual(
      (yield* send("GET", "/api/plugins/other-plugin/hello", { token: "Bearer read" })).status,
      404,
    );
    assert.strictEqual(
      (yield* send("GET", "/api/plugins/http-plugin/missing", { token: "Bearer read" })).status,
      404,
    );
    assert.deepStrictEqual(
      yield* send("GET", "/api/plugins/http-plugin/fail", { token: "Bearer read" }),
      {
        status: 500,
        contentType: "text/plain",
        body: "Plugin http-plugin failed to handle the request.",
      },
    );

    yield* routes.unregisterPlugin(httpPlugin);
    assert.strictEqual(
      (yield* send("GET", "/api/plugins/http-plugin/hello", { token: "Bearer read" })).status,
      404,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("signs in like the rest of /api: reads need read, other methods operate", () =>
  Effect.gen(function* () {
    const { send } = yield* serveFixture();
    assert.strictEqual((yield* send("GET", "/api/plugins/http-plugin/hello")).status, 401);
    assert.strictEqual(
      (yield* send("POST", "/api/plugins/http-plugin/echo", { token: "Bearer read", body: "{}" }))
        .status,
      403,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
