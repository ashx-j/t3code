import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

// A plain map with one version: Settings reads it on render and re-renders on the version alone,
// so a plugin never adds a subscription per row.
const webFailures = new Map<string, string>();

// Reads go through atoms derived from the version, so React Compiler cannot cache a stale lookup.
const versionAtom = Atom.make(0).pipe(Atom.keepAlive);

const bump = () => appAtomRegistry.set(versionAtom, appAtomRegistry.get(versionAtom) + 1);

const pluginContributionKey = (environmentId: EnvironmentId, pluginId: string) =>
  `${environmentId}\u0000${pluginId}`;

/** Records why a plugin's stylesheets did not load; `undefined` clears it. */
export function setPluginWebFailure(
  environmentId: EnvironmentId,
  pluginId: string,
  message: string | undefined,
) {
  const key = pluginContributionKey(environmentId, pluginId);
  if (webFailures.get(key) === message) return;
  if (message === undefined) webFailures.delete(key);
  else webFailures.set(key, message);
  bump();
}

/** Why the plugin's styles failed, by environment, for its row in Settings. */
export const pluginWebFailuresAtom = Atom.family((pluginId: string) =>
  Atom.make((get): ReadonlyMap<string, string> => {
    get(versionAtom);
    const suffix = `\u0000${pluginId}`;
    return new Map(
      [...webFailures].flatMap(([key, message]) =>
        key.endsWith(suffix) ? [[key.slice(0, -suffix.length), message] as const] : [],
      ),
    );
  }),
);
