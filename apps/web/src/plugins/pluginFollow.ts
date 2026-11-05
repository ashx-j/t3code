import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/**
 * The environment whose plugin list the app follows. `PluginLoaderStarter` sets it once the app
 * is idle, so readers of that list open no stream during startup.
 */
export const followedPluginEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-followed-plugin-environment"),
);
