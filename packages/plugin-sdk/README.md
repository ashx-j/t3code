# @t3tools/plugin-sdk

Types and build helpers for T3 Code plugins. A plugin is a folder with a `t3-plugin.json` manifest,
an optional server half that runs inside the T3 Code server, and an optional web half that runs in
the web and desktop apps. Plugins are trusted code: they run with the same access as T3 Code.

[`examples/`](./examples) has plugins to copy from. The plugins in [`fixtures/`](./fixtures) back
the tests and are small and working too; `hello-web` uses most of the web API and is built with the
Vite preset below.

## Manifest

```json
{
  "id": "hello-web",
  "name": "Hello web",
  "version": "0.1.0",
  "description": "Shown on the Plugins page.",
  "engines": { "t3": ">=0.1.6" },
  "server": "./server.cjs",
  "web": "./web.js",
  "settingsSchema": {
    "type": "object",
    "properties": { "token": { "type": "string", "format": "t3-secret" } }
  }
}
```

- `id` uses lowercase letters, digits and hyphens. It names the plugin's folder, its HTTP routes
  (`/api/plugins/<id>/…`), its agent tools (`plg_<id>_<tool>`) and its keybinding commands
  (`plugin.<id>.<command>`).
- `engines.t3` is a semver range. A server outside it refuses to start the plugin and says why.
- `server` must be CommonJS ending in `.cjs`. `web` is a single-file ES module.
- `settingsSchema` is JSON Schema. T3 Code draws a form from it on the Plugins page, and fields with
  `"format": "t3-secret"` are stored in the server's secret store and never shown again.
- A `themes/` folder of theme JSON files is published while the plugin is active, and an `assets/`
  folder is served to the web half when the plugin has one.

## Server half

```js
/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register("greeting", () => "Hello", { access: "read" });
    api.turns.afterRunCompleted((run) => api.log.info("run ended", { status: run.status }));
  },
};
```

`activate` receives the [`PluginApi`](./src/server.ts): settings, storage, RPC methods and
channels for the web half, stored orchestration events, threads and projects, notes in threads,
send hooks and run-completed hooks, MCP tools for agents, HTTP routes, schedules and server info.
Everything a plugin registers is released when it is disabled, reloaded or uninstalled; add your
own cleanup with `api.onDeactivate`.

## Web half

```tsx
import { Button } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

export default defineWebPlugin({
  activate(api) {
    api.rightPanel.register({
      name: "hello",
      title: "Hello",
      component: () => <Button onClick={() => api.navigate("/settings/plugins")}>Settings</Button>,
    });
    api.commands.register({
      id: "say-hello",
      title: "Say hello",
      run: () => api.toast({ title: "Hello" }),
    });
  },
});
```

`activate` receives the [`WebPluginApi`](./src/web.ts): calls into the server half, right panels,
a settings panel, palette commands, composer slash commands and banners, timeline renderers for
the plugin's agent tools, renderers for fenced code languages, styles, assets, navigation and
toasts.

Build it with the Vite preset, which makes the bundle use T3 Code's own React, atom hooks and UI
components instead of shipping copies:

```ts
// vite.config.ts
import { t3PluginWeb } from "@t3tools/plugin-sdk/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [t3PluginWeb({ entry: "web.tsx", outDir: "dist" })] });
```

Point the manifest's `web` at `dist/web.js`. Only the hooks listed in `HOST_ATOM_REACT_EXPORTS` and
the components in `@t3tools/plugin-sdk/ui` are shared.

## Developing a plugin

Add your plugin folder to `devPaths` in `plugins.json` in the T3 Code data directory, then enable
it on the Plugins page. **Reload** restarts it with your latest files. To install a finished
plugin, use **Add plugin** on the Plugins page with a folder or a git repository.
