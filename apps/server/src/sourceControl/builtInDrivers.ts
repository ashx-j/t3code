import { SourceControlProviderKind } from "@t3tools/contracts";
import type {
  SourceControlDriver,
  SourceControlDriverInstance,
  SourceControlDriverServices,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

export class SourceControlDriverKindTakenError extends Schema.TaggedError<SourceControlDriverKindTakenError>()(
  "SourceControlDriverKindTakenError",
  { kind: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot add the source control host '${this.kind}': ${this.reason}`;
  }
}

/**
 * Hosts plugins add after startup. Lookups read `current()` after the built-ins, so a server
 * without plugins only reads an empty list. Each driver is built once, in its own scope, with the
 * services and rate limit built-ins share, and its definition joins the shared registry so remote
 * recognition finds it.
 */
export class SourceControlPluginDrivers extends Context.Service<
  SourceControlPluginDrivers,
  {
    readonly current: () => ReadonlyArray<SourceControlDriverEntry>;
    /** Builds the driver and returns the effect that removes it again. */
    readonly add: (
      driver: SourceControlDriver,
    ) => Effect.Effect<Effect.Effect<void>, SourceControlDriverKindTakenError>;
  }
>()("t3/sourceControl/builtInDrivers/SourceControlPluginDrivers") {}

const make = Effect.forEach(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST, (driver) =>
  driver.make.pipe(Effect.map((instance) => ({ driver, instance }))),
);

/** @public */
export const makePluginDrivers = Effect.gen(function* () {
  const context = yield* Effect.context<SourceControlDriverServices>();
  const scope = yield* Effect.scope;
  const builtInKinds = new Set<string>(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map(({ kind }) => kind));
  let entries: ReadonlyArray<SourceControlDriverEntry> = [];
  return SourceControlPluginDrivers.of({
    current: () => entries,
    add: Effect.fn("SourceControlPluginDrivers.add")(function* (driver) {
      const taken = (reason: string) =>
        new SourceControlDriverKindTakenError({ kind: driver.kind, reason });
      if (builtInKinds.has(driver.kind)) return yield* taken("T3 Code provides it.");
      if (entries.some((entry) => entry.driver.kind === driver.kind)) {
        return yield* taken("another plugin provides it.");
      }
      const childScope = yield* Scope.fork(scope);
      // The captured context holds the layer's own scope, so the child goes into it. A plugin's
      // `make` can fail in ways its type does not admit; whatever stops it closes what it opened.
      const instance = yield* driver.make.pipe(
        Effect.provideContext(Context.add(context, Scope.Scope, childScope)),
        Effect.onError(() => Scope.close(childScope, Exit.void)),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.fail(taken(`its driver failed to start: ${String(Cause.squash(cause))}`)),
        ),
      );
      const unregister = yield* Effect.try({
        try: () => sourceControlDefinitions.register(driver.definition),
        catch: () => taken("its definition's kind is taken."),
      }).pipe(Effect.tapError(() => Scope.close(childScope, Exit.void)));
      const entry: SourceControlDriverEntry = { driver, instance };
      entries = [...entries, entry];
      return Effect.sync(() => {
        entries = entries.filter((other) => other !== entry);
        unregister();
      }).pipe(Effect.andThen(Scope.close(childScope, Exit.void)));
    }),
  });
});

export const layer = Layer.mergeAll(
  Layer.effect(SourceControlDrivers, make),
  Layer.effect(SourceControlPluginDrivers, makePluginDrivers),
).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);

/** The kind a plugin's driver claims, checked like contracts check every host kind. */
export const isSourceControlProviderKind = Schema.is(SourceControlProviderKind);
