import {
  type ProviderDriverKind,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import type { PluginAcpAgent } from "@t3tools/plugin-sdk/server/providers";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The services an ACP agent's instances use, all of which built-in drivers also get. */
export type AcpAgentDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderHost.ProviderHost;

/** What a user may change on an instance: a different command or arguments. */
const AcpAgentSettings = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
});
type AcpAgentSettings = typeof AcpAgentSettings.Type;

const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Default",
  isCustom: false,
  isDefault: true,
  capabilities: null,
};

/**
 * A provider driver for an ACP agent a plugin names by its command: the shared ACP adapter with
 * the base ACP capabilities, a snapshot that never starts the agent, and no text generation.
 * Agents that need vendor behavior get a driver of their own.
 */
export const makeAcpAgentDriver = (
  agent: PluginAcpAgent & { readonly kind: ProviderDriverKind },
): ProviderDriver<AcpAgentSettings, AcpAgentDriverEnv> => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${agent.label} does not write text for T3 Code.`,
      }),
    );
  const textGeneration: ProviderTextGeneration = {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
  const models: ReadonlyArray<ServerProviderModel> =
    agent.models === undefined || agent.models.length === 0
      ? [DEFAULT_MODEL]
      : agent.models.map((model, index) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          isDefault: index === 0,
          capabilities: null,
        }));
  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
    provider: agent.kind,
    packageName: null,
  });
  return {
    driverKind: agent.kind,
    metadata: { displayName: agent.label },
    configSchema: AcpAgentSettings,
    defaultConfig: () => ({}),
    create: Effect.fn("PluginAcpAgentDriver.create")(
      function* ({ instanceId, displayName, accentColor, environment, enabled, config }) {
        // Instance variables override the plugin's, which override the server's.
        const processEnvironment = yield* mergeProviderInstanceEnvironment(environment, {
          ...(yield* HostProcess.Environment),
          ...agent.env,
        });
        const command = config.command?.trim() || agent.command;
        const args = config.args ?? agent.args ?? [];
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: agent.kind,
          instanceId,
        });
        const snapshot = withInstanceIdentity({
          instanceId,
          driverKind: agent.kind,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        })({
          ...buildServerProvider({
            presentation: { displayName: agent.label, showInteractionModeToggle: false },
            enabled,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            models,
            // Status checks must not start the agent, so sign-in stays unknown until a turn.
            probe: { installed: true, version: null, status: "ready", auth: { status: "unknown" } },
          }),
          supportsTextGeneration: false,
        });
        const orchestrationAdapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: agent.kind,
            runtimeHarness: agent.label,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: ({
              runtimePolicy: _runtimePolicy,
              processEnvironment: turnEnv,
              ...input
            }) =>
              Layer.build(
                AcpSessionRuntime.layer({
                  ...input,
                  spawn: {
                    command,
                    args,
                    cwd: input.cwd,
                    env: { ...processEnvironment, ...turnEnv },
                  },
                }),
              ).pipe(
                Effect.flatMap((context) =>
                  Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context)),
                ),
              ),
          },
        });
        return {
          instanceId,
          driverKind: agent.kind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot: {
            resolveMaintenance: () => Effect.succeed(maintenance),
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter,
          textGeneration,
        };
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: agent.kind,
                instanceId: input.instanceId,
                detail: `Could not start ${agent.label}.`,
                cause,
              }),
          ),
        ),
    ),
  };
};
