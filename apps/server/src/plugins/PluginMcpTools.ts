import {
  PluginId,
  PluginInstallSource,
  type PluginState,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type { PluginMcpTool, PluginRpcAccess } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { abortEffect } from "./api/facade.ts";
import type { PluginCheckReport } from "./pluginCheck.ts";

// MCP clients reject longer tool names.
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_REASON_CHARS = 500;
const PLUGINS_LIST_TOOL = "t3_plugins_list";
const PLUGINS_INVOKE_TOOL = "t3_plugins_invoke";
const PLUGINS_SET_ENABLED_TOOL = "t3_plugins_set_enabled";
const PLUGINS_INSTALL_TOOL = "t3_plugins_install";
const PLUGINS_UNINSTALL_TOOL = "t3_plugins_uninstall";
const PLUGINS_RELOAD_TOOL = "t3_plugins_reload";
const PLUGINS_CHECK_TOOL = "t3_plugins_check";
const PLUGINS_SETTINGS_TOOL = "t3_plugins_settings";

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

export class PluginMcpManagementError extends Schema.TaggedError<PluginMcpManagementError>()(
  "PluginMcpManagementError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** What the management tools do. The plugin host supplies them, since it depends on this service. */
export interface PluginMcpHostActions {
  readonly invoke: (
    pluginId: PluginId,
    method: string,
    input: Schema.Json | undefined,
  ) => Effect.Effect<Schema.Json, { readonly message: string }>;
  readonly setEnabled: (
    pluginId: PluginId,
    enabled: boolean,
  ) => Effect.Effect<PluginState, { readonly message: string }>;
  readonly reload: (pluginId: PluginId) => Effect.Effect<PluginState, { readonly message: string }>;
  readonly install: (
    source: PluginInstallSource,
  ) => Effect.Effect<PluginState, { readonly message: string }>;
  readonly uninstall: (
    pluginId: PluginId,
    removeData: boolean,
    linkedFolder?: string,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly check: (
    target: { readonly pluginId: PluginId } | { readonly path: string },
  ) => Effect.Effect<PluginCheckReport, { readonly message: string }>;
  /** Saved settings as clients see them, with secrets redacted, and the schema that lists them. */
  readonly getSettings: (
    pluginId: PluginId,
  ) => Effect.Effect<
    { readonly settings: Schema.JsonObject; readonly settingsSchema?: Schema.JsonObject },
    { readonly message: string }
  >;
  readonly updateSettings: (
    pluginId: PluginId,
    patch: Schema.JsonObject,
  ) => Effect.Effect<Schema.JsonObject, { readonly message: string }>;
  /** Slash command names with each plugin's id, so agents can send `/name` to a thread. */
  readonly slashCommands: Effect.Effect<
    ReadonlyArray<{ readonly pluginId: string; readonly name: string }>
  >;
}

const decodeInvokeInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    pluginId: PluginId,
    method: Schema.String,
    input: Schema.optional(Schema.Json),
  }),
);
const decodeSetEnabledInput = Schema.decodeUnknownEffect(
  Schema.Struct({ pluginId: PluginId, enabled: Schema.Boolean }),
);
const decodeSettingsInput = Schema.decodeUnknownEffect(
  Schema.Struct({ pluginId: PluginId, values: Schema.optional(Schema.JsonObject) }),
);
const decodeInstallInput = Schema.decodeUnknownEffect(
  Schema.Struct({ source: PluginInstallSource }),
);
const decodeUninstallInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    pluginId: PluginId,
    removeData: Schema.optional(Schema.Boolean),
    linkedFolder: Schema.optional(Schema.String),
  }),
);
const decodeReloadInput = Schema.decodeUnknownEffect(Schema.Struct({ pluginId: PluginId }));
const decodeCheckInput = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ pluginId: PluginId }),
    Schema.Struct({ path: TrimmedNonEmptyString }),
  ]),
);

// What a lifecycle tool returns: enough to see whether the plugin runs, and why not.
const toolState = (state: PluginState) => ({
  id: state.id,
  status: state.status,
  enabled: state.enabled,
  ...(state.failure === undefined
    ? {}
    : { failure: `${state.failure.stage}: ${state.failure.message}` }),
  ...(state.webFailure === undefined ? {} : { webFailure: state.webFailure }),
  ...(state.linkedFolder === undefined ? {} : { linkedFolder: state.linkedFolder }),
});

/** One tool as `/mcp` advertises it. `call` runs it; McpHttpServer checks `access` first. */
export interface PluginMcpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  /** Picked per call by a tool whose input decides whether it reads or changes something. */
  readonly access: PluginRpcAccess | ((input: Schema.JsonObject) => PluginRpcAccess);
  readonly call: (
    input: Schema.JsonObject,
    caller: { readonly threadId: string | null },
  ) => Effect.Effect<
    Schema.Json,
    PluginMcpToolError | PluginMcpToolDisabledError | PluginMcpManagementError
  >;
}

export class PluginMcpTools extends Context.Service<
  PluginMcpTools,
  {
    /** Offers `tool` to agents as `plg_<pluginId>_<name>`, replacing a tool of that name. */
    readonly register: (input: {
      readonly pluginId: PluginId;
      readonly tool: PluginMcpTool;
      /** `signal` aborts when the agent cancels the call. */
      readonly handler: (
        input: Schema.JsonObject,
        context: { readonly signal: AbortSignal; readonly threadId: string | null },
      ) => Promise<Schema.Json>;
      /** Aborts when the plugin turns off; a call still running then answers that it is disabled. */
      readonly deactivated: AbortSignal;
    }) => Effect.Effect<void, PluginMcpToolNameError>;
    /** MCP has no tool removal, so each of the plugin's tools answers "disabled" instead. */
    readonly unregisterPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /**
     * Offers the `t3_plugins_*` management tools once a plugin is installed; agents without
     * plugins never pay for them.
     */
    readonly setInstalledPlugins: (plugins: ReadonlyArray<PluginState>) => Effect.Effect<void>;
    /** Connects the management tools to the plugin host. */
    readonly setHostActions: (actions: PluginMcpHostActions) => Effect.Effect<void>;
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
  let hostActions: PluginMcpHostActions | undefined;
  const withHost = <A>(
    run: (actions: PluginMcpHostActions) => Effect.Effect<A, { readonly message: string }>,
  ) =>
    hostActions === undefined
      ? Effect.fail(new PluginMcpManagementError({ reason: "Plugins are still starting." }))
      : run(hostActions).pipe(
          Effect.mapError((error) => new PluginMcpManagementError({ reason: error.message })),
        );
  const invalidInput = (cause: { readonly message: string }) =>
    new PluginMcpManagementError({ reason: `Invalid input: ${cause.message}` });

  const publish = Effect.fnUntraced(function* (entry: PluginMcpToolEntry) {
    tools.set(entry.name, entry);
    for (const publisher of publishers) yield* publisher(entry);
  });

  const pluginsList: PluginMcpToolEntry = {
    name: PLUGINS_LIST_TOOL,
    description:
      "List the plugins installed in this T3 Code environment, with each one's status, whether it is enabled, why its last start or its web half in the browser failed, if either did, and the linkedFolder of each copy loaded from a folder with link: true.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    access: "read",
    call: () =>
      (hostActions?.slashCommands ?? Effect.succeed([])).pipe(
        Effect.map((commands) => ({
          plugins: installed.map((plugin) => ({
            ...toolState(plugin),
            name: plugin.name,
            version: plugin.version ?? null,
            slashCommands: commands
              .filter((command) => command.pluginId === plugin.id)
              .map((command) => `/${command.name}`),
          })),
        })),
      ),
  };

  const pluginsInvoke: PluginMcpToolEntry = {
    name: PLUGINS_INVOKE_TOOL,
    description:
      "Call a method an installed plugin registered, with optional JSON input, and return its result. Use t3_plugins_list to see plugins.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        method: { type: "string" },
        input: { description: "JSON passed to the method." },
      },
      required: ["pluginId", "method"],
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeInvokeInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) =>
          withHost((actions) => actions.invoke(request.pluginId, request.method, request.input)),
        ),
      ),
  };

  const pluginsSetEnabled: PluginMcpToolEntry = {
    name: PLUGINS_SET_ENABLED_TOOL,
    description: "Turn an installed plugin on or off and return its new status.",
    inputSchema: {
      type: "object",
      properties: { pluginId: { type: "string" }, enabled: { type: "boolean" } },
      required: ["pluginId", "enabled"],
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeSetEnabledInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) =>
          withHost((actions) => actions.setEnabled(request.pluginId, request.enabled)),
        ),
        Effect.map(toolState),
      ),
  };

  const pluginsInstall: PluginMcpToolEntry = {
    name: PLUGINS_INSTALL_TOOL,
    description:
      "Install a plugin into this T3 Code environment from a folder on the server, a git repository or npm, then enable it. While writing a plugin, install its folder with link: true: T3 loads the folder where it is, so editing files and calling t3_plugins_reload is the whole loop, and uninstalling only unlinks it. Run t3_plugins_check on a plugin to find problems. Plugins run with T3 Code's own access, so only install what the user asked for.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "path" },
                path: { type: "string" },
                link: {
                  type: "boolean",
                  description: "Load the folder in place instead of copying it.",
                },
              },
              required: ["type", "path"],
            },
            {
              type: "object",
              properties: {
                type: { const: "git" },
                url: { type: "string" },
                ref: { type: "string" },
              },
              required: ["type", "url"],
            },
            {
              type: "object",
              properties: {
                type: { const: "npm" },
                name: { type: "string" },
                version: {
                  type: "string",
                  description: "An exact version such as 1.2.3. Leave it out for the latest.",
                },
              },
              required: ["type", "name"],
            },
          ],
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeInstallInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) => withHost((actions) => actions.install(request.source))),
        Effect.map(toolState),
      ),
  };

  const pluginsUninstall: PluginMcpToolEntry = {
    name: PLUGINS_UNINSTALL_TOOL,
    description:
      "Remove an installed plugin, or unlink one installed with link: true. Set removeData to also delete its settings and stored data. When a linked copy is not the one in use, pass its linkedFolder from t3_plugins_list to unlink only that copy.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        removeData: { type: "boolean" },
        linkedFolder: { type: "string" },
      },
      required: ["pluginId"],
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeUninstallInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) =>
          withHost((actions) =>
            actions.uninstall(request.pluginId, request.removeData === true, request.linkedFolder),
          ),
        ),
        Effect.as({ removed: true }),
      ),
  };

  const pluginsReload: PluginMcpToolEntry = {
    name: PLUGINS_RELOAD_TOOL,
    description:
      "Restart an installed plugin with its current files, including a changed t3-plugin.json, and return its status and why it failed, if it did. Run t3_plugins_check on it to find the cause of a failure. An open T3 Code window loads its web half after this returns; t3_plugins_list then shows whether that failed.",
    inputSchema: {
      type: "object",
      properties: { pluginId: { type: "string" } },
      required: ["pluginId"],
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeReloadInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) => withHost((actions) => actions.reload(request.pluginId))),
        Effect.map(toolState),
      ),
  };

  const pluginsCheck: PluginMcpToolEntry = {
    name: PLUGINS_CHECK_TOOL,
    description:
      'Check a plugin for problems without running it: its manifest, its T3 Code version range, its entry files, how its web bundle was built, and CSS or selectors likely to break when T3 Code updates. Give pluginId for an installed plugin, or path for a plugin folder on the server; for an installed plugin it also reports why its last start or its web half failed. Returns each problem with a one-line fix. The "Keeping a plugin working across T3 updates" section of the @t3tools/plugin-sdk README explains the warnings.',
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "An installed plugin's id." },
        path: { type: "string", description: "A plugin folder on the server." },
      },
      additionalProperties: false,
    },
    // A path can name any folder on the server, which a read-only client must not probe.
    access: (input) => (input.path === undefined ? "read" : "write"),
    call: (input) =>
      decodeCheckInput(input).pipe(
        Effect.mapError(() => invalidInput({ message: "Give either pluginId or path." })),
        Effect.flatMap((target) => withHost((actions) => actions.check(target))),
      ),
  };

  const pluginsSettings: PluginMcpToolEntry = {
    name: PLUGINS_SETTINGS_TOOL,
    description:
      "Read an installed plugin's saved settings and its settingsSchema, which lists every setting with its type and default, or change them by passing values: each key sets that setting, and null removes it so the plugin reads its default. A change the schema rejects returns why. Secrets read as redacted.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        values: { type: "object", description: "Settings to change. Leave out to read them." },
      },
      required: ["pluginId"],
      additionalProperties: false,
    },
    access: (input) => (input.values === undefined ? "read" : "write"),
    call: (input) =>
      decodeSettingsInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap(({ pluginId, values }) =>
          withHost((actions) =>
            values === undefined
              ? actions.getSettings(pluginId)
              : actions
                  .updateSettings(pluginId, values)
                  .pipe(Effect.map((settings) => ({ settings }))),
          ),
        ),
      ),
  };

  return PluginMcpTools.of({
    register: Effect.fn("PluginMcpTools.register")(function* ({
      pluginId,
      tool,
      handler,
      deactivated,
    }) {
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
        call: (input, caller) =>
          Effect.raceFirst(
            Effect.tryPromise({
              try: (signal) => handler(input, { signal, threadId: caller.threadId }),
              catch: failed,
            }).pipe(
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
            // A handler that ignores its abort signal must not hold the agent's call open.
            abortEffect(deactivated).pipe(
              Effect.andThen(Effect.fail(new PluginMcpToolDisabledError({ pluginId }))),
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
      if (plugins.length > 0 && !tools.has(PLUGINS_LIST_TOOL)) {
        for (const entry of [
          pluginsList,
          pluginsInvoke,
          pluginsSetEnabled,
          pluginsInstall,
          pluginsUninstall,
          pluginsReload,
          pluginsCheck,
          pluginsSettings,
        ]) {
          yield* publish(entry);
        }
      }
    }),
    setHostActions: Effect.fn("PluginMcpTools.setHostActions")((actions) =>
      Effect.sync(() => {
        hostActions = actions;
      }),
    ),
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
