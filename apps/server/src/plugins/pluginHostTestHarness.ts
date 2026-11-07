// @effect-diagnostics preferSchemaOverJson:off - like the tests, it writes manifests as plain JSON.
// The plugin host with its real stores and registries, for its tests and the tests of the modules
// it builds.
import type { PluginState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginHttpRoutes from "./PluginHttpRoutes.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

export const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url)
  .pathname;

export const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }));

// Services the plugins in these tests never reach.
const layerUnusedLaunchServices = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);

// Orchestration services the lifecycle tests never reach.
export const layerUnusedServices = Layer.mergeAll(
  layerUnusedLaunchServices,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ServerSettings.ServerSettingsService)({}),
);

// Every list of theme folders the host published, for the web files case.
export const publishedThemeDirectories: Array<ReadonlyArray<string>> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories.push(directories);
    }),
});

export const layerHost = (services: typeof layerUnusedServices = layerUnusedServices) =>
  Layer.fresh(
    PluginHost.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(PluginSettingsStore.layer, PluginStorage.layer)),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(services),
      Layer.provide(layerThemes),
      Layer.provideMerge(
        Layer.mergeAll(PluginHooks.layer, PluginMcpTools.layer, PluginHttpRoutes.layer),
      ),
    ),
  );

/** The real file system with some of its methods replaced, for the host's layer. */
export const layerFileSystemWith = (
  replace: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.use((fs) => Effect.succeed({ ...fs, ...replace(fs) })),
  );

export const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

export const writePluginsConfig = Effect.fn(function* (config: {
  readonly enabled?: Record<string, boolean>;
  readonly devPaths?: ReadonlyArray<string>;
}) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  yield* writeFile(`${stateDir}/plugins.json`, JSON.stringify(config));
});

/** A plugin written for one test, under `<stateDir>/plugins/<id>`. */
export const writeInstalledPlugin = Effect.fn(function* (id: string, serverSource: string) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const rootDir = `${stateDir}/plugins/${id}`;
  yield* writeFile(
    `${rootDir}/t3-plugin.json`,
    JSON.stringify({
      id,
      name: id,
      version: "0.1.0",
      engines: { t3: ">=0.1.0" },
      server: "./server.cjs",
    }),
  );
  yield* writeFile(`${rootDir}/server.cjs`, serverSource);
  return rootDir;
});

export const stateOf = (states: ReadonlyArray<PluginState>, id: string) =>
  states.find((state) => state.id === id);

/** Resolves with the first list where every listed plugin has its expected status. */
export const waitForStatuses = (
  host: PluginHost.PluginHost["Service"],
  expected: Readonly<Record<string, PluginState["status"]>>,
) =>
  host.streamStates.pipe(
    Stream.filter((states) =>
      Object.entries(expected).every(([id, status]) => stateOf(states, id)?.status === status),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
