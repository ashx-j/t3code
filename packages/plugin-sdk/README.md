# T3 Code plugins

A plugin is a folder with a `t3-plugin.json` manifest and theme files that change how T3 Code looks.
It runs no code.

## Manifest

```json
{
  "id": "hello-web",
  "name": "Hello web",
  "version": "0.1.0",
  "description": "Shown on the Plugins page.",
  "engines": { "t3": ">=0.1.6" }
}
```

- `id` uses lowercase letters, digits and hyphens, starts with a letter and has up to 32
  characters. It names the plugin's folder.
- `engines.t3` is a version range made of `^`, `>=`, `>`, `<=`, `<`, `=` and `||`, such as
  `>=0.1.6`. A server outside it refuses to start the plugin, and says why.
- `permissions` is an optional list of what the plugin says it uses. Settings → Plugins shows it on
  the plugin's row, and T3 Code doesn't enforce it.
- A `themes/` folder of theme JSON files is published while the plugin is active. T3 Code
  remembers the published themes, so the boot screen and the desktop window start in the active
  theme's colors. A theme that sets `"sidebarArtwork": true` keeps the nightly and dev artwork in
  the sidebar, which T3 otherwise swaps for a label; the send button stays plain. `"radius"`, such
  as `"0.625rem"`, sets T3's corner radius, and `success`, `successForeground`, `info` and
  `infoForeground` in a theme's `colors` or `variants` set its status colors.

## Developing a plugin

Add the plugin's folder to `devPaths` in `plugins.json` in the T3 Code data directory, turn the
plugin on in Settings → Plugins, and use **Reload** after each change. A linked folder whose id an
installed plugin already has fails as a duplicate, so remove the installed copy first.
