import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";

export class PullRequestProviderRegistry extends Context.Service<
  PullRequestProviderRegistry,
  {
    readonly get: (kind: SourceControlProviderKind) => PullRequestProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/pullRequest/PullRequestProviderRegistry") {}

export function fromProviders(
  providers: ReadonlyArray<PullRequestProviderApi>,
): PullRequestProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const plugins = yield* BuiltInDrivers.SourceControlPluginDrivers;
  const builtIn = fromProviders(drivers.flatMap(({ instance }) => instance.pullRequests ?? []));
  const pluginProviders = () =>
    plugins.current().flatMap(({ instance }) => instance.pullRequests ?? []);
  return {
    get: (kind) =>
      builtIn.get(kind) ?? pluginProviders().find((provider) => provider.kind === kind) ?? null,
    get kinds() {
      const added = pluginProviders();
      return added.length === 0
        ? builtIn.kinds
        : [...builtIn.kinds, ...added.map((provider) => provider.kind)];
    },
  } satisfies PullRequestProviderRegistry["Service"];
});

export const layer = Layer.effect(PullRequestProviderRegistry, make).pipe(
  Layer.provide(BuiltInDrivers.layer),
);
