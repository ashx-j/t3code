import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  PluginId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";

const scopesByToken: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer read": [AuthOrchestrationReadScope],
  "Bearer none": [],
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

it.effect("signs in like reads on the rest of /api and answers 404 for other plugins", () =>
  Effect.gen(function* () {
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
    const routes = Context.get(services, PluginHttpRoutes.PluginHttpRoutes);
    yield* routes.register({
      pluginId: PluginId.make("styles-plugin"),
      path: "/styles/*",
      handler: async (request) => ({ status: 200, body: `${request.path} ${request.query.v}` }),
    });
    const client = Context.get(services, HttpClient.HttpClient);
    const get = Effect.fn(function* (path: string, token?: string) {
      const response = yield* client.execute(
        HttpClientRequest.get(path).pipe(
          token === undefined
            ? (request) => request
            : HttpClientRequest.setHeader("authorization", token),
        ),
      );
      return { status: response.status, body: yield* response.text };
    });

    assert.strictEqual((yield* get("/api/plugins/styles-plugin/styles/base.css")).status, 401);
    assert.strictEqual(
      (yield* get("/api/plugins/styles-plugin/styles/base.css", "Bearer none")).status,
      403,
    );
    assert.deepStrictEqual(
      yield* get("/api/plugins/styles-plugin/styles/base.css?v=r1", "Bearer read"),
      { status: 200, body: "/styles/base.css r1" },
    );
    assert.strictEqual(
      (yield* get("/api/plugins/other-plugin/styles/base.css", "Bearer read")).status,
      404,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
