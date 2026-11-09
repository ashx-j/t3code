# @t3tools/plugin-sdk

Types for T3 Code plugins. A plugin is a folder with a `t3-plugin.json` manifest, theme files and
stylesheets that change how T3 Code looks, and an optional server half that runs inside the T3 Code
server. Plugins are trusted code: they run with the same access as T3 Code.

The plugins in [`fixtures/`](./fixtures) back the tests and are small and working too. They are
written by hand and need no build.

## Manifest

```json
{
  "id": "hello-web",
  "name": "Hello web",
  "version": "0.1.0",
  "description": "Shown on the Plugins page.",
  "engines": { "t3": ">=0.1.6" },
  "server": "./server.cjs"
}
```

- `id` uses lowercase letters, digits and hyphens, starts with a letter and has up to 32
  characters. It names the plugin's folder.
- `engines.t3` is a version range made of `^`, `>=`, `>`, `<=`, `<`, `=` and `||`, such as
  `>=0.1.6`. A server outside it refuses to install the plugin or start it, and says why.
- `permissions` is an optional list of what the plugin says it uses. Settings → Plugins shows it on
  the plugin's row, and T3 Code doesn't enforce it.
- `server` must be CommonJS ending in `.cjs`. A plugin with a `server` runs only on a T3 Code
  server running Node 24 or later, such as the desktop app's. On an older Node, such as `npx t3` on
  Node 22, it fails to start and says why.
- A `themes/` folder of theme JSON files is published while the plugin is active. T3 Code
  remembers the published themes, so the boot screen and the desktop window start in the active
  theme's colors. A theme that sets `"sidebarArtwork": true` keeps the nightly and dev artwork in
  the sidebar, which T3 otherwise swaps for a label; the send button stays plain. `"radius"`, such
  as `"0.625rem"`, sets T3's corner radius, and `success`, `successForeground`, `info` and
  `infoForeground` in a theme's `colors` or `variants` set its status colors.
- A `styles/` folder of `.css` files is added to the page while the plugin is active, in name
  order, after T3's own styles and the theme. A manifest and `styles/` are a whole plugin, as in
  the `styles-plugin` fixture. Styles and themes load only from the environments turned on under
  **Load plugin UI from** in Settings → Plugins, which starts with just the main environment.
  **Reload** picks up edits. The page gets each file's text, so a `url()` can't reach the
  plugin's folder; use a `data:` URL for an image.

## Server half

```js
/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register("greeting", () => "Hello", { access: "read" });
  },
};
```

`activate` receives the [`PluginApi`](./src/server.ts): RPC methods and channels for clients.

Everything a plugin registers is released when it is disabled, reloaded or uninstalled; add your
own cleanup with `api.onDeactivate`.

`rpc.register` takes an `access`. Any session that can read the environment may call a `read`
method, a guest's read-only session included. A `write` method needs the `orchestration:operate`
scope, which the owner's sessions have and a read-only session lacks. The handler's second argument
has the caller's `access` and a `signal`. The signal aborts when the caller goes away, the plugin
stops, or 30 seconds pass, and a method that hasn't answered by then fails. A client can send any
JSON as input, so check it before acting on it.

`rpc.publish` sends a value to every session that follows the channel, and any session that can
read the environment may follow one, so never publish secrets. A subscriber gets only the values
published after it subscribes, so give subscribers a method that returns the current value. A
subscriber that falls behind keeps the latest 64 values of each channel and loses older ones.

A promise rejection in plugin code that nothing handles, such as in a timer, doesn't stop T3 Code.
It shows on the plugin's row in Settings → Plugins, and the plugin keeps running. An exception
nothing catches does stop the server. When T3 Code can tell it was your plugin's, the plugin stays
off after the restart until the user turns it on again. That includes a throw in a timer callback
and an `'error'` event with no listener, so catch errors in callbacks and give every child process,
socket and stream you create an `'error'` listener.

## Keeping a plugin working across T3 updates

T3 changes its markup, class names, labels and layout in most releases. You don't need to drop
parts of your design to survive that. Build each part on the most stable thing T3 offers for it:

- **Style with theme tokens.** Colors, radii and fonts come from the theme. Set them in a theme
  file in `themes/`, and use `var(--border)`, `var(--radius)` and the other tokens in your styles
  instead of hex or rgb values.
- **Scope CSS to a region.** T3 keeps the `data-t3-region` names of the window's main areas
  across releases: `sidebar`, `main` (everything beside the sidebar), `timeline`, `composer`,
  `thread-details`, `right-panel`, `terminal`, `home`, `pull-requests`, `settings`,
  `settings-nav` and `command-palette`. A plain `background` rule recolors most regions, such as
  `[data-t3-region="composer"] { background: #101820; }`. The surfaces inside `main`,
  `right-panel` and `pull-requests` paint over them, so set `--background` on those three instead.
  For `terminal`, set `--terminal-background`, which a terminal reads when it opens. `terminal` is
  the drawer under the chat. A terminal opened in the right panel has no `terminal` region, so set
  `--terminal-background` on `right-panel` to reach it.
- **Reach into T3's markup only as a last resort.** Selectors on `aria-label`, `data-slot`, class
  names such as `[class~="border-border/65"]` or `.lucide-shield-off`, and `:has()` break when T3
  renames or moves things. Use one only when no theme value or region does the job. Keep each rule
  small and in one commented place, prefer one that falls back to T3's own look when the markup
  changes, and list it in the plugin's README with the seam that would replace it.
- **Leave T3's frame to T3.** The title bar row, the room for the window buttons on Windows and
  Linux, drag areas, phone safe areas and breakpoints are T3's, so don't resize or pad them.
- **Check `api.version` before using a newer API member.** A member added after version 1 names
  the version that added it in its doc, so a plugin can skip that feature on an older T3 and keep
  running. To require a T3 release instead, set `engines.t3`.
- **Ship what the plugin runs.** Installing a folder leaves out `.git` and `node_modules`, so
  build everything into the files the manifest names.
- **Ask for a seam.** When T3 doesn't hand over what you need, ask for a region or token on the
  T3 Code repository instead of reaching into its markup.

## Developing a plugin

Add the plugin's folder to `devPaths` in `plugins.json` in the T3 Code data directory, turn the
plugin on in Settings → Plugins, and use **Reload** after each change. **Unlink** on its row removes
it from `devPaths` and leaves the folder alone. A linked folder whose id an installed plugin already
has fails as a duplicate, so remove the installed copy first.

To install a finished plugin, drag its folder onto Settings → Plugins, or use **Add plugin** to
choose it. Unlink a linked copy first. It installs turned off, so turn it on on its row.
