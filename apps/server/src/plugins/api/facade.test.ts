import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import { makePluginActivation, type PluginPublication } from "../PluginApi.ts";
import { makeFacadeContext } from "./facade.ts";
import { PluginThreadNotFoundError } from "./threads.ts";

// Two macrotask turns: Node reports a rejection nobody observed after the first.
const afterNodeReportsRejections = Effect.promise(async () => {
  for (let turn = 0; turn < 2; turn++) {
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
    await new Promise((resolve) => setImmediate(resolve));
  }
});

it.effect("keeps a failed call the plugin never awaits from stopping the server", () =>
  Effect.gen(function* () {
    const activation = makePluginActivation(yield* PubSub.sliding<PluginPublication>(1));
    const facade = makeFacadeContext({
      pluginId: PluginId.make("unawaited"),
      activation,
      context: yield* Effect.context<never>(),
    });
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => process.off("unhandledRejection", onUnhandled)),
    );

    void facade.call(Effect.fail(new PluginThreadNotFoundError({ threadId: "thread:gone" })));
    activation.controller.abort();
    activation.ended.abort();
    // A timer such as `setInterval(() => void api.storage.set(...))` outliving the plugin.
    void facade.call(Effect.void);
    yield* afterNodeReportsRejections;
    assert.deepStrictEqual(unobserved, []);

    const awaited = yield* Effect.promise(() =>
      facade.call(Effect.void).then(
        () => undefined,
        (error: { readonly code: string }) => error.code,
      ),
    );
    assert.strictEqual(awaited, "PluginDeactivated");
  }).pipe(Effect.scoped),
);
