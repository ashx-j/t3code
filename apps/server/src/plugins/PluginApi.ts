import { PluginRpcName, type PluginId } from "@t3tools/contracts";
import type { PluginApi, PluginRpcAccess, PluginRpcHandler } from "@t3tools/plugin-sdk/server";
import type * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import type * as SecretRequests from "../secrets/SecretRequests.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeEventsApi, storedEvents } from "./api/events.ts";
import { makeFacadeContext, refused } from "./api/facade.ts";
import { makeHttpApi } from "./api/http.ts";
import { makeProvidersApi } from "./api/providers.ts";
import type { RuntimeRequestHooks } from "./api/runtimeRequests.ts";
import { makeScheduleApi } from "./api/schedule.ts";
import { makeSecretsApi } from "./api/secrets.ts";
import { makeServerApi } from "./api/server.ts";
import { makeSlashCommandsApi } from "./api/slashCommands.ts";
import { makeGenerateText, makeTextGenerationApi } from "./api/textGeneration.ts";
import { makeProjectsApi, makeThreadsApi } from "./api/threads.ts";
import { makeTurnsApi, T3_STORAGE_PREFIX } from "./api/turns.ts";
import { makeWorktreesApi } from "./api/worktrees.ts";
import type * as PluginHooks from "./PluginHooks.ts";
import type * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
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
  /** Aborted when deactivation starts; handler signals, iterators and timers follow it. */
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
  readonly version: string;
  readonly settings: PluginSettingsStore.PluginSettingsStore["Service"];
  readonly storage: PluginStorage.PluginStorage["Service"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly eventStore: OrchestrationEventStore.OrchestrationEventStore["Service"];
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly launches: ThreadLaunchService.ThreadLaunchService["Service"];
  readonly projectService: ProjectService.ProjectService["Service"];
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly secretRequests: SecretRequests.SecretRequests["Service"];
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
  readonly providers: ProviderRegistry.ProviderRegistry["Service"];
  readonly hooks: PluginHooks.PluginHooksRegistry;
  readonly runtimeRequests: RuntimeRequestHooks;
  readonly httpRoutes: PluginHttpRoutes.PluginHttpRoutes["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly crypto: Crypto.Crypto;
}

/**
 * Builds the object a plugin's `activate` receives. Effect stays on this side: every call runs
 * with the host's services and settles as a plain Promise that rejects with an `Error`.
 */
export const makePluginApi = (input: {
  readonly id: PluginId;
  readonly name: string;
  readonly rootDir: string;
  readonly settingsSchema: Schema.JsonObject | undefined;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  readonly services: PluginApiServices;
  /** Failures of plugin callbacks that only T3 waits on, shown on the plugin's row. */
  readonly onFailure: (error: unknown) => void;
}): PluginApi => {
  const { id, activation, context, services } = input;
  const facade = makeFacadeContext({
    pluginId: id,
    activation,
    context,
    onFailure: input.onFailure,
  });
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

  const ownStorage: Pick<PluginApi["storage"], "get" | "set"> = {
    get: (key) => call(services.storage.get(id, key).pipe(Effect.map(Option.getOrUndefined))),
    set: (key, value) => {
      if (!isJson(value)) return refused(new TypeError("Storage values must be JSON."));
      return call(services.storage.set(id, key, value));
    },
  };
  // Plain-JS plugins can pass any key; a non-text one must reject like other bad calls, not throw.
  const isT3Key = (key: unknown) => typeof key === "string" && key.startsWith(T3_STORAGE_PREFIX);
  const refuseT3Key = () =>
    refused(new TypeError(`Storage keys starting with "${T3_STORAGE_PREFIX}" belong to T3.`));
  const storage: PluginApi["storage"] = {
    get: ownStorage.get,
    set: (key, value) => (isT3Key(key) ? refuseT3Key() : ownStorage.set(key, value)),
    delete: (key) => (isT3Key(key) ? refuseT3Key() : call(services.storage.remove(id, key))),
    list: (prefix) =>
      call(
        services.storage
          .list(id, prefix)
          .pipe(Effect.map((keys) => keys.filter((key) => !isT3Key(key)))),
      ),
  };
  const events = makeEventsApi(facade, services);

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
    events,
    threads: makeThreadsApi(facade, services, input.name),
    projects: makeProjectsApi(facade, services),
    secrets: makeSecretsApi(facade, services),
    worktrees: makeWorktreesApi(facade, services),
    schedule: makeScheduleApi(facade),
    turns: makeTurnsApi(facade, services, {
      storage: ownStorage,
      pluginName: input.name,
      runEvents: (afterSequence) =>
        storedEvents(facade, services, { types: ["run.updated"], afterSequence }, "suspend"),
      latestSequence: () =>
        Effect.runPromiseWith(facade.context)(services.eventStore.latestAgentSequence()),
    }),
    slashCommands: makeSlashCommandsApi(facade, services, input.name),
    textGeneration: {
      ...makeTextGenerationApi(facade, services),
      generate: makeGenerateText(facade, services, input.rootDir),
    },
    providers: makeProvidersApi(facade, services),
    http: makeHttpApi(facade, services),
    server: makeServerApi(facade, {
      version: services.version,
      environment: services.environment,
      settings: services.serverSettings,
    }),
  };
};
