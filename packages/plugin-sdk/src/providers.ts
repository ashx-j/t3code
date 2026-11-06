// Types for plugins that add ACP agents and source control hosts. Source control types come from
// T3 Code's own packages, which change with every nightly: such a plugin is built against one T3
// Code version.
import type { providerAuth } from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlDriverModule from "@t3tools/source-control-core/server/driver";
import type { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/source-control-core/shared/definition";
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
import type * as PubSub from "effect/PubSub";
import type * as Queue from "effect/Queue";
import type * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export type { SourceControlProviderInfo } from "@t3tools/contracts";

/**
 * A source control host: a definition clients and remote recognition read, and a driver the
 * server builds once. Build `make` with `api.providers.runtime`.
 */
export type PluginSourceControlDriver = SourceControlDriverModule.SourceControlDriver;

export type {
  SourceControlDriverInstance,
  SourceControlDriverServices,
} from "@t3tools/source-control-core/server/driver";
export type { SourceControlProviderDiscoverySpec } from "@t3tools/source-control-core/server/discovery";
export type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
export type {
  GitRemoteHost,
  SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
export type {
  SourceControlProvider,
  SourceControlProviderContext,
} from "@t3tools/source-control-core/server/SourceControlProvider";

/** Plain helpers for source control definitions. */
export interface PluginSourceControlRuntime {
  /** T3 Code's definition for an unknown host; spread it and override what your host does. */
  readonly unknownDefinition: typeof UNKNOWN_SOURCE_CONTROL_CLIENT;
  /** Builds the sign-in state a discovery spec's `probeAuth` reports. */
  readonly providerAuth: typeof providerAuth;
}

/** An ACP agent T3 Code runs by its command, with the shared ACP adapter. */
export interface PluginAcpAgent {
  /**
   * The provider driver kind: a letter, then letters, digits, `_` or `-`, at most 64 characters,
   * unique among drivers.
   */
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
 * T3 Code's own Effect modules. The server bundles its own copy of `effect`, so a source control
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
  readonly Crypto: typeof Crypto.Crypto;
}
