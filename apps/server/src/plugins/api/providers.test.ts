import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { guardedDriver } from "./providers.ts";

it.layer(TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer)))(
  "guardedDriver",
  (it) => {
    it.effect("fails a plugin's create that never finishes, so the registry can go on", () =>
      Effect.gen(function* () {
        const driver = guardedDriver(
          {
            driverKind: ProviderDriverKind.make("hungAgent"),
            metadata: { displayName: "Hung agent" },
            configSchema: Schema.Struct({}),
            defaultConfig: () => ({}),
            create: () => Effect.never,
          },
          {},
        );
        const created = yield* driver
          .create({
            instanceId: ProviderInstanceId.make("hungAgent"),
            displayName: undefined,
            environment: [],
            enabled: true,
            config: {},
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("20 seconds");
        assert.strictEqual(
          (yield* Fiber.join(created)).detail,
          "The plugin's create did not finish within 20 seconds.",
        );
      }).pipe(Effect.scoped),
    );
  },
);
