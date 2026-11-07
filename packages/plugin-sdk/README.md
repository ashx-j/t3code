# @t3tools/plugin-sdk

Types and build helpers for T3 Code plugins. A plugin is a folder with a `t3-plugin.json` manifest,
an optional server half that runs inside the T3 Code server, and an optional web half that runs in
the web and desktop apps. Plugins are trusted code: they run with the same access as T3 Code.

[`examples/`](./examples) has plugins to copy from. Their web halves are built, not committed: run
`vp run build:examples` in `packages/plugin-sdk` before adding an example to T3 Code. Each one
builds to its own `dist/web.js` with the Vite preset below. The plugins in
[`fixtures/`](./fixtures) back the tests and are small and working too. They are written by hand
and need no build. `hello-web` uses most of the web API.

## Install

```sh
npm install --save-dev @t3tools/plugin-sdk
```

The SDK has no dependencies of its own. What else a plugin needs depends on its parts:

- A web half needs `react` and `@types/react` as dev dependencies, plus `react-dom` if it imports
  it, and Vite 8 or later to build it. The bundle uses T3's own React at runtime, but the build
  reads React's exports.
- Atoms from `@t3tools/plugin-sdk/atom` need `effect`. So does typechecking a server half, which
  also needs `@types/node`. Use the `effect` version the SDK lists as a peer dependency.

To use an SDK that isn't on npm, such as one from a fork, run `vp run build` in
`packages/plugin-sdk` of a T3 Code checkout. Then run `npm pack` in its `dist` folder and install
the `.tgz` file it writes.

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

- `id` uses lowercase letters, digits and hyphens, starts with a letter and has up to 32
  characters. It names the plugin's folder, its HTTP routes (`/api/plugins/<id>/…`), its agent
  tools (`plg_<id>_<tool>`) and its keybinding commands (`plugin.<id>.<command>`).
- `engines.t3` is a version range made of `^`, `>=`, `>`, `<=`, `<`, `=` and `||`, such as
  `>=0.1.6`. A server outside it refuses to install the plugin, update to it or start it, and says
  why.
- `permissions` is an optional list of what the plugin says it uses. Settings → Plugins shows it on
  the plugin's row, and T3 Code doesn't enforce it.
- `server` must be CommonJS ending in `.cjs`. `web` is a single-file ES module.
- `settingsSchema` is JSON Schema. T3 Code draws a form from it on the Plugins page, and top-level
  string fields with `"format": "t3-secret"` are stored in the server's secret store and never shown
  again. `t3-secret` anywhere else is saved as plain text, and `t3_plugins_check` warns about it.
  The form covers top-level strings, numbers, integers, booleans, `enum`s of strings or numbers,
  and arrays of strings. One property of any other shape, such as an object or a nullable type,
  turns the whole form into a JSON box. Every save is checked against the schema with the top-level `default`s
  filled in, so a default its own field rejects refuses every save; `t3_plugins_check` reports it.
  Agents read the settings and the schema, and change settings, with the `t3_plugins_settings`
  tool.
- A `themes/` folder of theme JSON files is published while the plugin is active, and an `assets/`
  folder is served to the web half when the plugin has one. T3 Code remembers the published
  themes, so the boot screen and the desktop window start in the active theme's colors. A theme
  that sets `"sidebarArtwork": true` keeps the nightly and dev artwork in the sidebar, which T3
  otherwise swaps for a label; the send button stays plain. `"radius"`, such as `"0.625rem"`, sets
  T3's corner radius, and `success`, `successForeground`, `info` and `infoForeground` in a theme's
  `colors` or `variants` set its status colors.
- A `styles/` folder of `.css` files is added to the page while the plugin is active, in name
  order, after T3's own styles and the theme. A manifest and `styles/` are a whole plugin, with
  no `server` or `web`, as in the `styles-plugin` fixture. Like a web half, styles load only from
  the main environment or the one picked in **Load plugin UI from** in Settings → Plugins.
  **Reload** picks up edits. The page gets each file's text, so a `url()` can't reach the
  plugin's folder; use a `data:` URL for an image.
- A `skills/` folder of `<name>/SKILL.md` skills reaches Claude and Codex agents while the plugin
  is active, and the composer's `$` menu lists them for those agents with the plugin's name. Claude
  invokes one as `<plugin id>:<folder>`, Codex by the `name` in its frontmatter. Nothing else in
  the plugin's folder reaches agents. The skills are copied when the plugin starts, so **Reload**
  picks up changes.

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
  projects, and list a project's git worktrees;
- provider instances and their models, with the options each model takes, such as reasoning
  effort (`api.providers.list`), so a new thread can set them in `threads.create`;
- send hooks that add to, replace or block a message, and slash commands that run on the server
  and may replace or block the message. A message's hooks share 2 seconds, and slash commands never
  reach them;
- answers to agents' approvals and questions, instructions for agents, and MCP tools for agents;
- secrets the user enters on a card in a thread with a turn in progress;
- the text T3 Code generates, such as thread titles and commit messages, and free-form text from
  the text generation model chosen in the settings. Each plugin gets 3 seconds to answer and all of
  them get 5, then T3 Code writes the text itself;
- HTTP routes, schedules and server info;
- ACP agents T3 Code runs by their command (`api.providers.registerAcpAgent`), with no Effect
  code; the `acp-agent-plugin` fixture is a small one;
- source control hosts (`api.sourceControl.registerDriver`), which join remote recognition and
  pull requests; the `source-control-plugin` fixture is a minimal one.

Everything a plugin registers is released when it is disabled, reloaded or uninstalled; add your
own cleanup with `api.onDeactivate`.

A failure in plugin code that nothing awaits, such as a throw in a timer, a schedule or a hook,
doesn't stop T3 Code. It shows on the plugin's row in Settings → Plugins and in
`t3_plugins_check`, and the plugin keeps running. Give every child process, socket and stream you
create an `'error'` listener anyway: Node reports an unhandled `'error'` event as a crash, and when
T3 Code can't tell it came from your plugin, the server stops.

HTTP route handlers get the request body as UTF-8 text, so a binary upload arrives corrupted, and a
query key that appears twice keeps its last value.

## Work that runs over many turns

A plugin can run work in steps, such as asking several models for an answer and then having each
one review the others. Start each model's thread with `threads.create`, with the model and options
`providers.list` names. T3 Code can restart between any 2 steps, and the plugin with it, so build
each step to resume:

- Keep each job's state in `storage`, such as `job:<id>` with its threads and the step it reached.
  Storage outlives restarts and updates.
- Move to the next step from `turns.afterRunCompleted`. Runs that end while the plugin is off
  arrive when it starts again. Each handler picks up where the one registered in its place last
  stopped, so register them in the same order at every start. Runs of every thread arrive, so look
  up `run.threadId` in your state. T3 waits for your handler before it sends the next run, and
  counts a run as handled once the handler resolves or throws, so a run whose handler a restart
  cut short arrives again.
- Pass an `idempotencyKey` to `threads.create` and `threads.sendMessage`, made from the job and the
  step, such as `review-42:answer:codex`. A call T3 already accepted with that key starts no new
  turn, so repeating a step after a restart costs nothing.
- Write back to a thread that may be busy with `sendMessage` and `mode: "queue"`, which waits for
  the running turn to end. The default, `auto`, steers the message into a running turn.
- To cancel a job, `interrupt` each of its threads, which resolves even when nothing is running,
  then `archive` or `delete` the ones you no longer need. An interrupted run arrives at
  `afterRunCompleted` with the status `interrupted`.
- Set `engines.t3` to the first T3 version that has every call you use, instead of checking
  `api.server.version`. An older T3 refuses to install or start the plugin and says why, where it
  would otherwise ignore a field it doesn't know, such as `idempotencyKey`. It also doesn't offer or
  install an update that needs a newer T3.

## Agent providers and source control hosts

An ACP agent needs no Effect code:

```js
api.providers.registerAcpAgent({
  kind: "my-agent",
  label: "My agent",
  command: "my-agent",
  args: ["acp"],
});
```

T3 Code runs it with its shared ACP adapter and gives each instance a form for the command and
arguments. The command must be an executable on the server, on its `PATH` or by absolute path. Do
not use `process.execPath` as the fixture does: in the installed app it is T3 Code itself, not
Node. `iconUrl` (https or `data:image`) gives the agent an icon. Users put secrets in the
instance's environment variables.

Source control hosts are Effect code that runs in the server: build them with the modules in
`api.providers.runtime` (and the helpers in `api.sourceControl.runtime`), never with an `effect`
you import, because the server bundles its own copy. Types come from one import,
`@t3tools/plugin-sdk/server/providers`, which carries a copy of T3 Code's internal source control
types from the version the SDK was built from. They change with every nightly, so use the SDK built
from the T3 Code version the plugin runs on, and expect to update it often.

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
a settings panel, palette commands (which the desktop app can also list in its menu), composer
slash commands and banners, timeline renderers for the plugin's agent tools, renderers for fenced
code languages, styles, assets, navigation and toasts.

`api.rpc.invoke` and `api.rpc.subscribe` reach the methods and channels the server half adds with
`rpc.register` and `rpc.publish`. Describe them once as a `PluginRpcMap` type from
`@t3tools/plugin-sdk/shared`, and pass it to both `definePlugin` and `defineWebPlugin`. Then a
wrong method name, input or value fails to typecheck in either half.
[`examples/quick-notes`](./examples/quick-notes) keeps its map in `rpc.ts`.

Plugins can also add buttons and menu items to T3's own toolbars and menus: under each message
(`messages.addAction`), in the thread header (`threads.addHeaderButton`), beside the composer's
attach button (`composer.addButton`) and in the thread actions menu (`threads.addMenuItem`).
`threads.setBadge` shows a short badge on a thread's sidebar row and header.
[`examples/review-flags`](./examples/review-flags) uses all of them. `composer.setMentionItems`
offers items in the composer's `@` menu; a picked item shows as a chip, and the agent gets its text
with the message. [`examples/quick-notes`](./examples/quick-notes) offers its notes that way.

`pages.register` adds a full page at `/plugins/<pluginId>/<name>`, shown beside the sidebar in
place of the thread; a `t3code://plugins/<pluginId>/<name>` link opens the desktop app on it.
`sidebar.addSection` adds a titled section under the thread list.
[`examples/quick-notes`](./examples/quick-notes) keeps notes in its server half's storage and shows
them in both.

`api.ui.replace(part, component)` draws one of T3's own parts your way. The component receives
T3's own controls as ready-made pieces to arrange, plus `original`, T3's own drawing of the part.
The parts and their pieces are listed in `WebPluginParts`. If your component throws, T3 draws its
own part. [`examples/classic-composer`](./examples/classic-composer) moves the composer's controls
back to their layout from before T3's redesign.
[`examples/message-extras`](./examples/message-extras) adds a word count under assistant messages,
redraws expanded commands and sums up diffs.

Build it with the Vite preset, which makes the bundle use T3 Code's own React, atoms, atom hooks and
UI components instead of shipping copies:

```ts
// vite.config.ts
import { t3PluginWeb } from "@t3tools/plugin-sdk/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [t3PluginWeb({ entry: "web.tsx", outDir: "dist" })] });
```

Point the manifest's `web` at `dist/web.js`. Only the hooks listed in `HOST_ATOM_REACT_EXPORTS`, the
`Atom` functions in `@t3tools/plugin-sdk/atom` and the components in `@t3tools/plugin-sdk/ui` are
shared.

Make atoms with `import * as Atom from "@t3tools/plugin-sdk/atom"`, not with `Atom` from `effect`,
which would bundle a second copy of effect. Build them from values and functions. An atom that runs
an Effect or a Stream would use your copy of effect inside T3's.
[`examples/quick-notes`](./examples/quick-notes) keeps its notes in an atom.

## Keeping a plugin working across T3 updates

T3 changes its markup, class names, labels and layout in most releases. You don't need to drop
parts of your design to survive that. Build each part on the most stable thing T3 offers for it:

- **Arrange pieces instead of rebuilding T3's controls.** `ui.replace` gives you T3's own controls,
  already wired up. Place them, wrap them or leave them out. A copied control, with its markup,
  icons and labels, misses every fix T3 makes to the real one.
- **Style with theme tokens.** Colors, radii and fonts come from the theme. Set them in a theme
  file in `themes/`, and use `var(--border)`, `var(--radius)` and the other tokens in your own
  components instead of hex or rgb values.
- **Scope CSS to a region.** T3 keeps the `data-t3-region` names of the window's main areas
  across releases: `sidebar`, `main` (everything beside the sidebar), `timeline`, `composer`,
  `thread-details`, `right-panel`, `terminal`, `home`, `pull-requests`, `settings`,
  `settings-nav`, `plugin-page` and `command-palette`. A plain `background` rule recolors most
  regions, such as `[data-t3-region="composer"] { background: #101820; }`. The surfaces inside
  `main` and `right-panel` paint over them, so set `--background` on those two instead. For
  `terminal`, set `--terminal-background`, which a terminal reads when it opens.
- **Reach into T3's markup only as a last resort.** Selectors on `aria-label`, `data-slot`, class
  names such as `[class~="border-border/65"]` or `.lucide-shield-off`, and `:has()` break when T3
  renames or moves things. Use one only when no theme value, region, piece or part does the job.
  Keep each rule small and in one commented place, prefer one that falls back to T3's own look
  when the markup changes, and list it in the plugin's README with the seam that would replace it.
- **Leave T3's frame to T3.** The title bar row, the room for the window buttons on Windows and
  Linux, drag areas, phone safe areas and breakpoints are T3's, so don't resize or pad them.
- **Draw `original` for steps you don't handle.** The `timeline.item` part's `item` describes
  commands, file changes, searches, tool calls and reasoning. Other kinds of step have the type
  `other`, and T3 can add kinds in any release.
- **Ship what the plugin runs.** Adding a folder leaves out `.git` and `node_modules`, and npm
  installs don't install dependencies, so build everything into the files the manifest names.
- **Ask for a seam.** When T3 doesn't hand over what you need, ask for a piece, part or token on
  the T3 Code repository instead of reaching into its markup.

After a T3 update, ask an agent to run `t3_plugins_check` on your plugin. It lists the patterns
above that your plugin uses, so you know what to recheck. If one of your replacements throws,
Settings → Plugins shows a note on the plugin's row, and T3 draws its own part there until the
plugin reloads.

## Developing a plugin

An agent writing a plugin installs its folder in place with `t3_plugins_install` and
`link: true`, then edits the files and calls `t3_plugins_reload` to load them. Nothing is copied,
and unlinking leaves the folder alone. `t3_plugins_check` lists what will stop the plugin from
loading and what is likely to break in a T3 update. Agents get these tools only after you turn on
the switch for them in Settings → Plugins. They are off until then. Without an agent, add the
folder to `devPaths` in `plugins.json` in the T3 Code data directory, turn the plugin on in
Settings → Plugins, and use **Reload** after each change.

To install a finished plugin, drag its folder onto Settings → Plugins, or use **Add plugin** with a
folder, a git repository or an npm package.
