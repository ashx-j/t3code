import { PluginId, type PluginState } from "@t3tools/contracts";
import type { PluginMcpTool, PluginRpcAccess } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

// MCP clients reject longer tool names.
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_REASON_CHARS = 500;
const PLUGINS_LIST_TOOL = "t3_plugins_list";

const isJson = Schema.is(Schema.Json);

export class PluginMcpToolNameError extends Schema.TaggedError<PluginMcpToolNameError>()(
  "PluginMcpToolNameError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Tool names use letters, digits, "_" and "-", and plg_${this.pluginId}_<name> must fit in ${MAX_TOOL_NAME_CHARS} characters.`;
  }
}
export const isPluginMcpToolNameError = Schema.is(PluginMcpToolNameError);

// `reason` is the plugin's own error text, bounded, so the agent can see why the tool failed.
export class PluginMcpToolError extends Schema.TaggedError<PluginMcpToolError>()(
  "PluginMcpToolError",
  { pluginId: PluginId, tool: Schema.String, reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed in ${this.tool}: ${this.reason}`;
  }
}

export class PluginMcpToolDisabledError extends Schema.TaggedError<PluginMcpToolDisabledError>()(
  "PluginMcpToolDisabledError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is disabled.`;
  }
}

/** One tool as `/mcp` advertises it. `call` runs it; McpHttpServer checks `access` first. */
export interface PluginMcpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  readonly access: PluginRpcAccess;
  readonly call: (
    input: Schema.JsonObject,
  ) => Effect.Effect<Schema.Json, PluginMcpToolError | PluginMcpToolDisabledError>;
}

export class PluginMcpTools extends Context.Service<
  PluginMcpTools,
  {
    /** Offers `tool` to agents as `plg_<pluginId>_<name>`, replacing a tool of that name. */
    readonly register: (input: {
      readonly pluginId: PluginId;
      readonly tool: PluginMcpTool;
      /** `signal` aborts when the agent cancels the call. */
      readonly handler: (input: Schema.JsonObject, signal: AbortSignal) => Promise<Schema.Json>;
    }) => Effect.Effect<void, PluginMcpToolNameError>;
    /** MCP has no tool removal, so each of the plugin's tools answers "disabled" instead. */
    readonly unregisterPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /** Offers `t3_plugins_list` once a plugin is installed; agents without plugins never pay for it. */
    readonly setInstalledPlugins: (plugins: ReadonlyArray<PluginState>) => Effect.Effect<void>;
    /** Hands `publish` every tool now and each change until the scope closes. */
    readonly attach: (
      publish: (tool: PluginMcpToolEntry) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/plugins/PluginMcpTools") {}

const errorText = (cause: unknown) => {
  let text = "Unknown error";
  try {
    text =
      cause instanceof Error && typeof cause.message === "string" ? cause.message : String(cause);
  } catch {
    // Plugin code can throw values whose conversion to a string throws again.
  }
  return text.slice(0, MAX_REASON_CHARS);
};

const make = () => {
  // Every change runs synchronously, so plugin activation can register a tool and return.
  const tools = new Map<string, PluginMcpToolEntry>();
  const toolsByPlugin = new Map<PluginId, Set<string>>();
  const publishers = new Set<(tool: PluginMcpToolEntry) => Effect.Effect<void>>();
  let installed: ReadonlyArray<PluginState> = [];

  const publish = Effect.fnUntraced(function* (entry: PluginMcpToolEntry) {
    tools.set(entry.name, entry);
    for (const publisher of publishers) yield* publisher(entry);
  });

  const pluginsList: PluginMcpToolEntry = {
    name: PLUGINS_LIST_TOOL,
    description:
      "List the plugins installed in this T3 Code environment, with each one's status and whether it is enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    access: "read",
    call: () =>
      Effect.sync(() => ({
        plugins: installed.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version ?? null,
          status: plugin.status,
          enabled: plugin.enabled,
        })),
      })),
  };

  return PluginMcpTools.of({
    register: Effect.fn("PluginMcpTools.register")(function* ({ pluginId, tool, handler }) {
      const name = `plg_${pluginId}_${tool.name}`;
      if (!TOOL_NAME_PATTERN.test(tool.name) || name.length > MAX_TOOL_NAME_CHARS) {
        return yield* new PluginMcpToolNameError({ pluginId });
      }
      const failed = (cause: unknown) =>
        new PluginMcpToolError({ pluginId, tool: tool.name, reason: errorText(cause), cause });
      const names = toolsByPlugin.get(pluginId) ?? new Set();
      toolsByPlugin.set(pluginId, names.add(name));
      yield* publish({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        access: tool.access,
        call: (input) =>
          Effect.tryPromise({ try: (signal) => handler(input, signal), catch: failed }).pipe(
            Effect.flatMap((output: unknown) =>
              output === undefined
                ? Effect.succeed(null)
                : isJson(output)
                  ? Effect.succeed(output)
                  : Effect.fail(
                      failed(new TypeError("The tool returned a value that is not JSON.")),
                    ),
            ),
          ),
      });
    }),
    unregisterPlugin: Effect.fn("PluginMcpTools.unregisterPlugin")(function* (pluginId) {
      const names = toolsByPlugin.get(pluginId);
      toolsByPlugin.delete(pluginId);
      for (const name of names ?? []) {
        const entry = tools.get(name);
        if (entry === undefined) continue;
        yield* publish({
          ...entry,
          call: () => Effect.fail(new PluginMcpToolDisabledError({ pluginId })),
        });
      }
    }),
    setInstalledPlugins: Effect.fn("PluginMcpTools.setInstalledPlugins")(function* (plugins) {
      installed = plugins;
      // Once advertised it stays: the list then reads empty when the last plugin is removed.
      if (plugins.length > 0 && !tools.has(PLUGINS_LIST_TOOL)) yield* publish(pluginsList);
    }),
    attach: Effect.fn("PluginMcpTools.attach")((publisher) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          publishers.add(publisher);
          for (const entry of tools.values()) yield* publisher(entry);
        }),
        () => Effect.sync(() => publishers.delete(publisher)),
      ),
    ),
  });
};

export const layer = Layer.sync(PluginMcpTools, make);
