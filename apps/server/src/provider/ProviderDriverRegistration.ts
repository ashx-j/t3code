import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { BuiltInDriversEnv } from "./builtInDrivers.ts";
import type { ProviderDriverKindTakenError } from "./ProviderInstanceRegistry.ts";

/**
 * Adds provider drivers after startup, for plugins. A driver here runs with the services the
 * built-in drivers get. The returned effect removes the driver and leaves its instances
 * unavailable.
 */
export class ProviderDriverRegistration extends Context.Service<
  ProviderDriverRegistration,
  {
    readonly add: (
      driver: AnyProviderDriver<BuiltInDriversEnv>,
    ) => Effect.Effect<Effect.Effect<void>, ProviderDriverKindTakenError>;
  }
>()("t3/provider/ProviderDriverRegistration") {}
