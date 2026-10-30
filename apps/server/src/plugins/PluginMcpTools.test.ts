import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PluginId,
  type PluginState,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { PluginApi, PluginDefinition } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../mcp/McpToolAccess.testkit.ts";
import { makeFacadeContext } from "./api/facade.ts";
import { makeMcpApi } from "./api/mcp.ts";
import { makePluginActivation, type PluginPublication } from "./PluginApi.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";

const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const mcpPlugin = PluginId.make("mcp-plugin");

const layerTest = McpHttpServer.layerPluginTools.pipe(
  Layer.provideMerge(PluginMcpTools.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(liveThreadsLayer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread:caller"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

// Plugin write tools need what environment writes need: a full-access caller.
const fullAccessClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:full",
  thread: undefined,
  client: { sessionId: "full", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
  capabilities: new Set(),
  issuedAt: 0,
};

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const toolNames = McpServer.McpServer.pipe(
  Effect.map((server) => server.tools.map(({ tool }) => tool.name)),
);

const isDefinition = (value: unknown): value is PluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

/** Activates the fixture with only the `mcp` group, the one it uses. */
const activateFixture = Effect.fn(function* () {
  const loaded: unknown = yield* Effect.promise(
    () => import(`${fixturesDir}mcp-plugin/server.cjs`),
  );
  const definition =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  assert(isDefinition(definition));
  const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
  const facade = makeFacadeContext({
    pluginId: mcpPlugin,
    activation,
    context: yield* Effect.context<never>(),
  });
  const api: Pick<PluginApi, "mcp"> = {
    mcp: makeMcpApi(facade, { mcpTools: yield* PluginMcpTools.PluginMcpTools }),
  };
  yield* Effect.promise(() => Promise.resolve(definition.activate(api as PluginApi)));
  return api;
});

const installed: PluginState = {
  id: mcpPlugin,
  name: "MCP tools",
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
  hasServer: true,
  hasWeb: false,
};

it.effect("answer under plg_ names with access checks, then answer disabled", () =>
  Effect.gen(function* () {
    const api = yield* activateFixture();
    api.mcp.registerTool(
      { name: "fail", description: "Throws.", inputSchema: { type: "object" }, access: "read" },
      () => {
        throw new Error("boom");
      },
    );
    assert.throws(
      () =>
        api.mcp.registerTool(
          { name: "no spaces", description: "", inputSchema: {}, access: "read" },
          () => null,
        ),
      TypeError,
    );

    const names = yield* toolNames;
    assert.includeMembers(names, ["plg_mcp-plugin_echo", "plg_mcp-plugin_touch"]);
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_echo", readOnlyClient, { text: "hi" }), {
      isError: false,
      text: '{"echoed":"hi"}',
    });
    const refused = yield* call("plg_mcp-plugin_touch", readOnlyClient);
    assert.isTrue(refused.isError);
    assert.include(refused.text, "read-only");
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_touch", fullAccessClient), {
      isError: false,
      text: '{"touches":1}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_fail", threadCaller), {
      isError: true,
      text: "Plugin mcp-plugin failed in fail: boom",
    });

    const tools = yield* PluginMcpTools.PluginMcpTools;
    yield* tools.unregisterPlugin(mcpPlugin);
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_echo", threadCaller, { text: "hi" }), {
      isError: true,
      text: "Plugin mcp-plugin is disabled.",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("offers the plugin management tools only once a plugin is installed", () =>
  Effect.gen(function* () {
    const tools = yield* PluginMcpTools.PluginMcpTools;
    const invoked: Array<unknown> = [];
    yield* tools.setHostActions({
      invoke: (pluginId, method, input) =>
        Effect.sync(() => {
          invoked.push({ pluginId, method, input });
          return "pong";
        }),
      setEnabled: (pluginId, enabled) => Effect.succeed({ ...installed, id: pluginId, enabled }),
    });
    yield* tools.setInstalledPlugins([]);
    assert.notInclude(yield* toolNames, "t3_plugins_list");

    yield* tools.setInstalledPlugins([installed]);
    assert.includeMembers(yield* toolNames, [
      "t3_plugins_list",
      "t3_plugins_invoke",
      "t3_plugins_set_enabled",
    ]);
    assert.deepStrictEqual(yield* call("t3_plugins_list", readOnlyClient), {
      isError: false,
      text: '{"plugins":[{"id":"mcp-plugin","name":"MCP tools","version":"0.1.0","status":"active","enabled":true}]}',
    });
    const ping = { pluginId: "mcp-plugin", method: "ping", input: { n: 1 } };
    assert.isTrue((yield* call("t3_plugins_invoke", readOnlyClient, ping)).isError);
    assert.deepStrictEqual(yield* call("t3_plugins_invoke", fullAccessClient, ping), {
      isError: false,
      text: '"pong"',
    });
    assert.deepStrictEqual(invoked, [ping]);
    assert.deepStrictEqual(
      yield* call("t3_plugins_set_enabled", fullAccessClient, {
        pluginId: "mcp-plugin",
        enabled: false,
      }),
      { isError: false, text: '{"id":"mcp-plugin","status":"active","enabled":false}' },
    );
  }).pipe(Effect.provide(layerTest)),
);
