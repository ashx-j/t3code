import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

/**
 * The environment whose plugin list the app follows. `PluginLoaderStarter` sets it once the app
 * is idle, so readers of that list open no stream during startup.
 */
export const followedPluginEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-followed-plugin-environment"),
);

const CHOSEN_ENVIRONMENT_KEY = "t3.plugins.uiEnvironment";
const isEnvironmentId = Schema.is(EnvironmentId);

// Reading localStorage throws where the browser blocks storage; plugin UI then stays off.
const chosenEnvironmentStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The environment the user picked in Settings to load plugin UI from in this browser. Read only
 * while there is no main environment. Plugin web code runs in this window, so it starts as none
 * and is kept in this browser alone.
 */
export const chosenPluginUiEnvironmentAtom = Atom.writable(
  (): EnvironmentId | null => {
    const stored = chosenEnvironmentStorage()?.getItem(CHOSEN_ENVIRONMENT_KEY) ?? null;
    return isEnvironmentId(stored) ? stored : null;
  },
  (ctx, environmentId: EnvironmentId | null) => {
    const storage = chosenEnvironmentStorage();
    try {
      if (environmentId === null) storage?.removeItem(CHOSEN_ENVIRONMENT_KEY);
      else storage?.setItem(CHOSEN_ENVIRONMENT_KEY, environmentId);
    } catch {
      // A full or blocked storage keeps the choice for this page only.
    }
    ctx.setSelf(environmentId);
  },
).pipe(Atom.keepAlive, Atom.withLabel("web-chosen-plugin-ui-environment"));
