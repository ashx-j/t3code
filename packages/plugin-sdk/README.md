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
- A `skills/` folder of `<name>/SKILL.md` skills reaches Claude and Codex agents while the plugin
  is active. Nothing else in the plugin's folder reaches them. The skills are copied when the
  plugin starts, so **Reload** picks up changes.

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

`activate` receives the [`PluginApi`](./src/server.ts):

- settings, storage, and RPC methods and channels for the web half;
- stored orchestration events, run-completed hooks and notes in threads;
- threads and projects: read, start, archive, snooze, settle and delete threads, add and change
  projects;
- send hooks that add to, replace or block a message, and slash commands that run on the server;
- answers to agents' approvals and questions, instructions for agents, and MCP tools for agents;
- the text T3 Code generates, such as thread titles and commit messages;
- HTTP routes, schedules and server info;
- ACP agents T3 Code runs by their command (`api.providers.registerAcpAgent`), with no Effect
  code; the `acp-agent-plugin` fixture is a complete one;
- source control hosts (`api.sourceControl.registerDriver`), which join remote recognition and
  pull requests; the `source-control-plugin` fixture is a minimal one;
- provider drivers, built with `api.providers.runtime` and typed with
  `@t3tools/plugin-sdk/server/providers`. These follow T3 Code's internal provider packages, which
  change with every nightly, so build a provider plugin against the T3 Code version it runs on.

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
a settings panel, palette commands (which the desktop app can also list in its menu or bind to a
global shortcut), composer slash commands and banners, timeline renderers for the plugin's agent
tools, renderers for fenced code languages, styles, assets, navigation and toasts.

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
