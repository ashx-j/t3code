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
import * as Fiber from "effect/Fiber";
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
  return { ...api, activation };
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
    api.mcp.registerTool(
      {
        name: "caller",
        description: "Names its caller.",
        inputSchema: { type: "object" },
        access: "read",
      },
      (_input, { threadId }) => ({ threadId }),
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
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_caller", threadCaller), {
      isError: false,
      text: '{"threadId":"thread:caller"}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_caller", fullAccessClient), {
      isError: false,
      text: '{"threadId":null}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_fail", threadCaller), {
      isError: true,
      text: "Plugin mcp-plugin failed in fail: boom",
    });

    // A call to a handler that ignores its abort signal ends when the plugin turns off.
    const reached = Promise.withResolvers<void>();
    api.mcp.registerTool(
      {
        name: "hang",
        description: "Never answers.",
        inputSchema: { type: "object" },
        access: "read",
      },
      () => {
        reached.resolve();
        return new Promise(() => undefined);
      },
    );
    const hanging = yield* call("plg_mcp-plugin_hang", threadCaller).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => reached.promise);
    api.activation.controller.abort();
    assert.deepStrictEqual(yield* Fiber.join(hanging), {
      isError: true,
      text: "Plugin mcp-plugin is disabled.",
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
    const checked: Array<unknown> = [];
    const uninstalled: Array<unknown> = [];
    const settingsPatches: Array<unknown> = [];
    yield* tools.setHostActions({
      invoke: (pluginId, method, input) =>
        Effect.sync(() => {
          invoked.push({ pluginId, method, input });
          return "pong";
        }),
      setEnabled: (pluginId, enabled) => Effect.succeed({ ...installed, id: pluginId, enabled }),
      install: () => Effect.succeed(installed),
      uninstall: (pluginId, removeData, linkedFolder) =>
        Effect.sync(() => {
          uninstalled.push({ pluginId, removeData, linkedFolder });
        }),
      reload: (pluginId) =>
        Effect.succeed({
          ...installed,
          id: pluginId,
          status: "failed",
          failure: { stage: "load", message: "Cannot find module './util'" },
        }),
      check: (target) =>
        Effect.sync(() => {
          checked.push(target);
          return { folder: "/home/user/plugin", pluginId: null, findings: [] };
        }),
      getSettings: () =>
        Effect.succeed({ settings: { mode: "a" }, settingsSchema: { type: "object" } }),
      updateSettings: (pluginId, patch) =>
        Effect.sync(() => {
          settingsPatches.push({ pluginId, patch });
          return { mode: "b" };
        }),
      slashCommands: Effect.succeed([{ pluginId: "mcp-plugin", name: "deploy" }]),
    });
    yield* tools.setInstalledPlugins([]);
    assert.notInclude(yield* toolNames, "t3_plugins_list");

    // A linked copy another copy shadows, which the uninstall tool removes by its folder.
    const shadowedLink: PluginState = {
      ...installed,
      status: "failed",
      linkedFolder: "/home/user/plugin",
      failure: { stage: "discovery", message: "Another copy is used." },
    };
    yield* tools.setInstalledPlugins([installed, shadowedLink]);
    assert.includeMembers(yield* toolNames, [
      "t3_plugins_list",
      "t3_plugins_invoke",
      "t3_plugins_set_enabled",
      "t3_plugins_install",
      "t3_plugins_uninstall",
      "t3_plugins_reload",
      "t3_plugins_check",
      "t3_plugins_settings",
    ]);
    assert.deepStrictEqual(yield* call("t3_plugins_list", readOnlyClient), {
      isError: false,
      text: JSON.stringify({
        plugins: [
          {
            id: "mcp-plugin",
            status: "active",
            enabled: true,
            name: "MCP tools",
            version: "0.1.0",
            slashCommands: ["/deploy"],
          },
          {
            id: "mcp-plugin",
            status: "failed",
            enabled: true,
            failure: "discovery: Another copy is used.",
            linkedFolder: "/home/user/plugin",
            name: "MCP tools",
            version: "0.1.0",
            slashCommands: ["/deploy"],
          },
        ],
      }),
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
    // A failed reload says why, so an agent can fix the plugin without opening Settings.
    assert.deepStrictEqual(
      yield* call("t3_plugins_reload", fullAccessClient, { pluginId: "mcp-plugin" }),
      {
        isError: false,
        text: '{"id":"mcp-plugin","status":"failed","enabled":true,"failure":"load: Cannot find module \'./util\'"}',
      },
    );
    const unnamed = yield* call("t3_plugins_check", readOnlyClient, {});
    assert.isTrue(unnamed.isError);
    assert.include(unnamed.text, "Give either pluginId or path.");
    // A path can name any folder on the server, so only an installed plugin is a read.
    const folder = { path: "/home/user/plugin" };
    assert.isTrue((yield* call("t3_plugins_check", readOnlyClient, folder)).isError);
    assert.isFalse((yield* call("t3_plugins_check", fullAccessClient, folder)).isError);
    assert.isFalse(
      (yield* call("t3_plugins_check", readOnlyClient, { pluginId: "mcp-plugin" })).isError,
    );
    assert.deepStrictEqual(checked, [folder, { pluginId: "mcp-plugin" }]);
    // Reading settings is a read; changing them needs write access.
    assert.deepStrictEqual(
      yield* call("t3_plugins_settings", readOnlyClient, { pluginId: "mcp-plugin" }),
      { isError: false, text: '{"settings":{"mode":"a"},"settingsSchema":{"type":"object"}}' },
    );
    const readOnlyHints = new Map(
      (yield* McpServer.McpServer).tools.map(({ tool }) => [
        tool.name,
        tool.annotations?.readOnlyHint,
      ]),
    );
    assert.isTrue(readOnlyHints.get("t3_plugins_list"));
    assert.isFalse(readOnlyHints.get("t3_plugins_settings"));
    const change = { pluginId: "mcp-plugin", values: { mode: "b" } };
    assert.isTrue((yield* call("t3_plugins_settings", readOnlyClient, change)).isError);
    assert.deepStrictEqual(yield* call("t3_plugins_settings", fullAccessClient, change), {
      isError: false,
      text: '{"settings":{"mode":"b"}}',
    });
    assert.deepStrictEqual(settingsPatches, [{ pluginId: "mcp-plugin", patch: { mode: "b" } }]);
    // One linked copy that isn't in use is unlinked by its folder, as Settings does it.
    yield* call("t3_plugins_uninstall", fullAccessClient, {
      pluginId: "mcp-plugin",
      linkedFolder: "/home/user/plugin",
    });
    assert.deepStrictEqual(uninstalled, [
      { pluginId: "mcp-plugin", removeData: false, linkedFolder: "/home/user/plugin" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);
