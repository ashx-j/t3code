import { PluginRpcName, type PluginId } from "@t3tools/contracts";
import type { PluginApi, PluginRpcAccess, PluginRpcHandler } from "@t3tools/plugin-sdk/server";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { makeFacadeContext, refused } from "./api/facade.ts";
import { makeMcpApi } from "./api/mcp.ts";
import type * as PluginMcpTools from "./PluginMcpTools.ts";
import type * as PluginSettingsStore from "./PluginSettingsStore.ts";
import type * as PluginStorage from "./PluginStorage.ts";

const isJson = Schema.is(Schema.Json);
const isPluginRpcName = Schema.is(PluginRpcName);
const isPluginRpcAccess = Schema.is(Schema.Literals(["read", "write"]));

export interface PluginPublication {
  readonly channel: string;
  readonly value: Schema.Json;
}

/** Everything one activation registered. The host routes calls through it and tears it down. */
export interface PluginActivation {
  readonly methods: Map<
    string,
    { readonly handler: PluginRpcHandler; readonly access: PluginRpcAccess }
  >;
  readonly cleanups: Array<() => void | Promise<void>>;
  /** Aborted when deactivation starts; handler signals and iterators follow it. */
  readonly controller: AbortController;
  /** Aborted once the cleanups have run; API calls are refused from then on. */
  readonly ended: AbortController;
  readonly publications: PubSub.PubSub<PluginPublication>;
}

export const makePluginActivation = (
  publications: PubSub.PubSub<PluginPublication>,
): PluginActivation => ({
  methods: new Map(),
  cleanups: [],
  controller: new AbortController(),
  ended: new AbortController(),
  publications,
});

const assertActive = (activation: PluginActivation) => {
  if (activation.controller.signal.aborted) {
    throw new Error("This plugin activation has ended.");
  }
};

/** The host services the facade reaches. The host builds this once and shares it. */
export interface PluginApiServices {
  readonly settings: PluginSettingsStore.PluginSettingsStore["Service"];
  readonly storage: PluginStorage.PluginStorage["Service"];
  readonly mcpTools: PluginMcpTools.PluginMcpTools["Service"];
}

/**
 * Builds the object a plugin's `activate` receives. Effect stays on this side: every call runs
 * with the host's services and settles as a plain Promise that rejects with an `Error`.
 */
export const makePluginApi = (input: {
  readonly id: PluginId;
  readonly rootDir: string;
  readonly settingsSchema: Schema.JsonObject | undefined;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  readonly services: PluginApiServices;
}): PluginApi => {
  const { id, activation, context, services } = input;
  const facade = makeFacadeContext({ pluginId: id, activation, context });
  const { call } = facade;
  const log =
    (level: "Debug" | "Info" | "Warn" | "Error") =>
    (message: string, fields?: Schema.JsonObject) => {
      Effect.runForkWith(context)(
        Effect.logWithLevel(level)(message, fields ?? {}).pipe(
          Effect.annotateLogs({ pluginId: id }),
        ),
      );
    };

  const storage: PluginApi["storage"] = {
    get: (key) => call(services.storage.get(id, key).pipe(Effect.map(Option.getOrUndefined))),
    set: (key, value) => {
      if (!isJson(value)) return refused(new TypeError("Storage values must be JSON."));
      return call(services.storage.set(id, key, value));
    },
    delete: (key) => call(services.storage.remove(id, key)),
    list: (prefix) => call(services.storage.list(id, prefix)),
  };

  return {
    version: 1,
    id,
    rootDir: input.rootDir,
    log: { debug: log("Debug"), info: log("Info"), warn: log("Warn"), error: log("Error") },
    settings: {
      get: () => call(services.settings.get(id, input.settingsSchema)),
      changes: () => facade.iterate(services.settings.changes(id)),
    },
    storage,
    rpc: {
      register: (method, handler, options) => {
        assertActive(activation);
        if (!isPluginRpcName(method))
          throw new TypeError(`"${method}" is not a valid method name.`);
        // Plugins are untyped JavaScript, and a misspelled access level must not open a write.
        if (!isPluginRpcAccess(options.access)) {
          throw new TypeError(`Method "${method}" needs access "read" or "write".`);
        }
        if (activation.methods.has(method)) {
          throw new Error(`Method "${method}" is already registered.`);
        }
        activation.methods.set(method, { handler, access: options.access });
      },
      publish: (channel, value) => {
        assertActive(activation);
        if (!isPluginRpcName(channel)) {
          throw new TypeError(`"${channel}" is not a valid channel name.`);
        }
        if (!isJson(value)) throw new TypeError("Published values must be JSON.");
        PubSub.publishUnsafe(activation.publications, { channel, value });
      },
    },
    // Something created after deactivation has nothing left to wait for, so it cleans up now.
    onDeactivate: (cleanup) => {
      if (activation.controller.signal.aborted) {
        void Promise.resolve()
          .then(cleanup)
          .catch(() => undefined);
        return;
      }
      activation.cleanups.push(cleanup);
    },
    mcp: makeMcpApi(facade, services),
  };
};
