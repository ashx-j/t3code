import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

/** Imported lazily by the Plugins page and the web plugin runtime, so startup never loads it. */
export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
