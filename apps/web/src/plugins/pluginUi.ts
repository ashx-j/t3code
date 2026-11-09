import { Atom } from "effect/reactivity";

import type { PluginUi } from "./pluginUiParts";

/**
 * The plugin UI code, which the plugin loader publishes once a plugin with a web part is active.
 * App code reaches plugin contributions only through this, so until then it downloads none of
 * that code and reads no plugin registry.
 */
export const pluginUiAtom = Atom.make<PluginUi | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-plugin-ui"),
);
