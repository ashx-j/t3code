import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createDiscussionState<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    detailQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:discussions:detail",
      tag: WS_METHODS.discussionsDetail,
      staleTimeMs: 60_000,
    }),
  };
}
