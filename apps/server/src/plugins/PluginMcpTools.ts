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

import { abortEffect, errorText } from "./api/facade.ts";
import { FRAGILE_CODES, type PluginCheckReport } from "./pluginCheck.ts";

// MCP clients reject longer tool names.
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
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
  Schema.Struct({
    path: Schema.optional(Schema.String),
    link: Schema.optional(Schema.Boolean),
    gitUrl: Schema.optional(Schema.String),
    gitRef: Schema.optional(Schema.String),
    npmPackage: Schema.optional(Schema.String),
    npmVersion: Schema.optional(Schema.String),
  }),
);
const decodeInstallSource = Schema.decodeUnknownEffect(PluginInstallSource);
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

const CHECK_NEXT = "Run t3_plugins_check for the cause and a fix.";
const failed = (state: PluginState) =>
  state.failure !== undefined ||
  state.webFailure !== undefined ||
  state.serverFailure !== undefined;

// What a lifecycle tool returns: enough to see whether the plugin runs, and why not.
const toolState = (state: PluginState) => ({
  id: state.id,
  status: state.status,
  enabled: state.enabled,
  ...(state.failure === undefined
    ? {}
    : { failure: `${state.failure.stage}: ${state.failure.message}` }),
  ...(state.webFailure === undefined ? {} : { webFailure: state.webFailure }),
  ...(state.serverFailure === undefined ? {} : { serverFailure: state.serverFailure }),
  ...(state.linkedFolder === undefined ? {} : { linkedFolder: state.linkedFolder }),
});

// Hints that cost nothing until they apply, instead of in every turn's tool descriptions.
const lifecycleResult = (state: PluginState) => {
  const next = failed(state)
    ? CHECK_NEXT
    : state.hasWeb && state.status === "active"
      ? "Its web half loads in open T3 Code windows after this returns; t3_plugins_list then shows any webFailure."
      : undefined;
  return { ...toolState(state), ...(next === undefined ? {} : { next }) };
};

/** One tool as `/mcp` advertises it. `call` runs it; McpHttpServer checks `access` first. */
export interface PluginMcpToolEntry {
  readonly name: string;
  /** Shown to people in MCP clients, not to the model. */
  readonly title?: string;
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
    /** The plugins `t3_plugins_list` reports. */
    readonly setInstalledPlugins: (plugins: ReadonlyArray<PluginState>) => Effect.Effect<void>;
    /**
     * Offers or withdraws the `t3_plugins_*` management tools. MCP has no tool removal, so a
     * session that already listed them keeps them, and they refuse every call.
     */
    readonly offerManagementTools: (offered: boolean) => Effect.Effect<void>;
    /** Connects the management tools to the plugin host. */
    readonly setHostActions: (actions: PluginMcpHostActions) => Effect.Effect<void>;
    /** Hands `publish` every tool now and each change until the scope closes. */
    readonly attach: (
      publish: (tool: PluginMcpToolEntry) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/plugins/PluginMcpTools") {}

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
      ? Effect.fail(
          new PluginMcpManagementError({
            reason: "Plugins are still starting. Call again in a moment.",
          }),
        )
      : run(hostActions).pipe(
          Effect.mapError((error) => new PluginMcpManagementError({ reason: error.message })),
        );
  const invalidInput = (cause: { readonly message: string }) =>
    new PluginMcpManagementError({ reason: `Invalid input: ${cause.message}` });
  // The tool takes flat fields, which agents fill in more reliably than a tagged union.
  const installSourceOf = (input: {
    readonly path?: string | undefined;
    readonly link?: boolean | undefined;
    readonly gitUrl?: string | undefined;
    readonly gitRef?: string | undefined;
    readonly npmPackage?: string | undefined;
    readonly npmVersion?: string | undefined;
  }) => {
    const given = [input.path, input.gitUrl, input.npmPackage].filter(
      (value) => value !== undefined,
    );
    if (given.length !== 1) {
      return Effect.fail(invalidInput({ message: "Give one of path, gitUrl or npmPackage." }));
    }
    return decodeInstallSource(
      input.path !== undefined
        ? {
            type: "path",
            path: input.path,
            ...(input.link === undefined ? {} : { link: input.link }),
          }
        : input.gitUrl !== undefined
          ? {
              type: "git",
              url: input.gitUrl,
              ...(input.gitRef === undefined ? {} : { ref: input.gitRef }),
            }
          : {
              type: "npm",
              name: input.npmPackage,
              ...(input.npmVersion === undefined ? {} : { version: input.npmVersion }),
            },
    ).pipe(Effect.mapError(invalidInput));
  };

  const publish = Effect.fnUntraced(function* (entry: PluginMcpToolEntry) {
    tools.set(entry.name, entry);
    for (const publisher of publishers) yield* publisher(entry);
  });

  const pluginsList: PluginMcpToolEntry = {
    name: PLUGINS_LIST_TOOL,
    title: "List plugins",
    description: "List installed plugins with status, failures, and slash commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    access: "read",
    call: () =>
      (hostActions?.slashCommands ?? Effect.succeed([])).pipe(
        Effect.map((commands) => ({
          plugins: installed.map((plugin) => {
            const slashCommands = commands
              .filter((command) => command.pluginId === plugin.id)
              .map((command) => `/${command.name}`);
            return {
              ...toolState(plugin),
              name: plugin.name,
              ...(plugin.version === undefined ? {} : { version: plugin.version }),
              ...(slashCommands.length === 0 ? {} : { slashCommands }),
            };
          }),
          ...(installed.some(failed) ? { next: CHECK_NEXT } : {}),
        })),
      ),
  };

  const pluginsInvoke: PluginMcpToolEntry = {
    name: PLUGINS_INVOKE_TOOL,
    title: "Call a plugin method",
    description: "Call a method a plugin registered with `api.rpc.register`.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        method: { type: "string" },
        input: {},
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
    title: "Enable or disable a plugin",
    description: "Enable or disable a plugin. Enable only what the user asked for.",
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
        Effect.map(lifecycleResult),
      ),
  };

  const pluginsInstall: PluginMcpToolEntry = {
    name: PLUGINS_INSTALL_TOOL,
    title: "Install a plugin",
    description:
      "Install and enable a plugin from a folder `path`, git or npm. Plugins run with T3 Code's access, so install only what the user asked for. While writing one, install its folder with `link: true`, then edit it and call `t3_plugins_reload`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        link: { type: "boolean" },
        gitUrl: { type: "string" },
        gitRef: { type: "string" },
        npmPackage: { type: "string" },
        npmVersion: { type: "string" },
      },
      additionalProperties: false,
    },
    access: "write",
    call: (input) =>
      decodeInstallInput(input).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((request) =>
          installSourceOf(request).pipe(
            Effect.flatMap((source) => withHost((actions) => actions.install(source))),
          ),
        ),
        Effect.map(lifecycleResult),
      ),
  };

  const pluginsUninstall: PluginMcpToolEntry = {
    name: PLUGINS_UNINSTALL_TOOL,
    title: "Remove a plugin",
    description:
      "Remove a plugin. A linked one is only unlinked; its folder stays. `removeData` also deletes its settings and storage.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        removeData: { type: "boolean" },
        linkedFolder: { type: "string", description: "Unlink only the copy from this folder." },
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
    title: "Reload a plugin",
    description: "Restart a plugin from its current files, t3-plugin.json included.",
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
        Effect.map(lifecycleResult),
      ),
  };

  const pluginsCheck: PluginMcpToolEntry = {
    name: PLUGINS_CHECK_TOOL,
    title: "Check a plugin",
    description:
      "Find a plugin's problems, each with a fix, without running it: its failures, manifest, build, and code likely to break when T3 updates. Pass `pluginId` or a folder `path`.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    // A path can name any folder on the server, which a read-only client must not probe.
    access: (input) => (input.path === undefined ? "read" : "write"),
    call: (input) =>
      decodeCheckInput(input).pipe(
        Effect.mapError(() => invalidInput({ message: "Give either pluginId or path." })),
        Effect.flatMap((target) => withHost((actions) => actions.check(target))),
        Effect.map((report) =>
          report.findings.some((finding) => FRAGILE_CODES.has(finding.code))
            ? {
                ...report,
                readme:
                  'The "Keeping a plugin working across T3 updates" section of the @t3tools/plugin-sdk README explains these warnings.',
              }
            : report,
        ),
      ),
  };

  const pluginsSettings: PluginMcpToolEntry = {
    name: PLUGINS_SETTINGS_TOOL,
    title: "Plugin settings",
    description:
      "Read a plugin's settings and settingsSchema, or change them with `values`. Omitted keys are unchanged; null resets one to its default.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        values: { type: "object" },
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
    setInstalledPlugins: Effect.fn("PluginMcpTools.setInstalledPlugins")((plugins) =>
      Effect.sync(() => {
        installed = plugins;
      }),
    ),
    offerManagementTools: Effect.fn("PluginMcpTools.offerManagementTools")(function* (offered) {
      if (offered === tools.has(PLUGINS_LIST_TOOL)) return;
      const managementTools = [
        pluginsList,
        pluginsInvoke,
        pluginsSetEnabled,
        pluginsInstall,
        pluginsUninstall,
        pluginsReload,
        pluginsCheck,
        pluginsSettings,
      ];
      for (const entry of managementTools) {
        if (offered) {
          yield* publish(entry);
          continue;
        }
        tools.delete(entry.name);
        const turnedOff = {
          ...entry,
          call: () =>
            Effect.fail(
              new PluginMcpManagementError({
                reason: "Plugin tools for agents are turned off in Settings > Plugins.",
              }),
            ),
        };
        for (const publisher of publishers) yield* publisher(turnedOff);
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
