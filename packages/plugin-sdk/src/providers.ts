// Types for plugins that add provider drivers. They come from T3 Code's own provider packages,
// which change with every nightly: a provider plugin is built against one T3 Code version.
import type { TextGenerationError } from "@t3tools/contracts";
import type * as ProviderDriverModule from "@t3tools/provider-core/server/driver";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import type { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import type * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import type * as DateTime from "effect/DateTime";
import type * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as PubSub from "effect/PubSub";
import type * as Queue from "effect/Queue";
import type * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { JsonObject } from "./shared.ts";

export type {
  ProviderDriverCreateInput,
  ProviderDriverMetadata,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
export type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
export type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

/** The services a plugin's driver may use; the host provides them as it does for its own. */
export type PluginProviderDriverEnv =
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto;

export type PluginProviderDriver<Config = unknown> = ProviderDriverModule.ProviderDriver<
  Config,
  PluginProviderDriverEnv
> & {
  /** What clients show for this driver, since they have no built-in definition for it. */
  readonly client?: {
    /**
     * JSON Schema of an instance's `config`, in the subset plugin settings use (an object of
     * strings, numbers, booleans, enums and string lists); clients draw the settings form from it.
     * Put secrets in the instance's environment variables, not here.
     */
    readonly settingsSchema?: JsonObject;
    /** An https or small data URL of at most 2,048 characters. */
    readonly iconUrl?: string;
  };
};

/** An ACP agent T3 Code runs by its command, with the shared ACP adapter. */
export interface PluginAcpAgent {
  /** The provider driver kind: letters, digits and `-`, unique among drivers. */
  readonly kind: string;
  readonly label: string;
  /** An executable on the server and its arguments; users can change both per instance. */
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Added to the server's environment; an instance's own variables win. */
  readonly env?: Readonly<Record<string, string>>;
  /** The models to offer, the first as default; without them T3 offers the agent's default. */
  readonly models?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** An https or small data URL of at most 2,048 characters. */
  readonly iconUrl?: string;
}

/**
 * T3 Code's own Effect and provider modules. The server bundles its own copy of `effect`, so a
 * driver builds its effects, schemas and services with these, never with an `effect` it imports.
 */
export interface PluginProviderRuntime {
  readonly Effect: typeof Effect;
  readonly Stream: typeof Stream;
  readonly Schema: typeof Schema;
  readonly Scope: typeof Scope;
  readonly Context: typeof Context;
  readonly Layer: typeof Layer;
  readonly Ref: typeof Ref;
  readonly PubSub: typeof PubSub;
  readonly Queue: typeof Queue;
  readonly Deferred: typeof Deferred;
  readonly Option: typeof Option;
  readonly Exit: typeof Exit;
  readonly Cause: typeof Cause;
  readonly Duration: typeof Duration;
  readonly DateTime: typeof DateTime;
  readonly Fiber: typeof Fiber;
  readonly FileSystem: typeof FileSystem.FileSystem;
  readonly Path: typeof Path.Path;
  readonly Crypto: typeof Crypto.Crypto;
  readonly ChildProcessSpawner: typeof ChildProcessSpawner.ChildProcessSpawner;
  readonly ProviderHost: typeof ProviderHost.ProviderHost;
  readonly ProviderAdapterV2: typeof ProviderAdapter.ProviderAdapterV2;
  readonly ProviderDriverError: typeof ProviderDriverError;
  readonly TextGenerationError: typeof TextGenerationError;
  readonly defaultProviderContinuationIdentity: typeof ProviderDriverModule.defaultProviderContinuationIdentity;
  readonly buildServerProvider: typeof buildServerProvider;
  readonly withInstanceIdentity: typeof withInstanceIdentity;
  readonly makeManagedServerProvider: typeof makeManagedServerProvider;
  readonly makeManualOnlyProviderMaintenanceCapabilities: typeof makeManualOnlyProviderMaintenanceCapabilities;
}
