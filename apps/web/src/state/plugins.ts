import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

/** Imported only by the Plugins settings page, so chat screens never load it. */
export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
