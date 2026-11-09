# T3 Code plugins

A plugin is a folder with a `t3-plugin.json` manifest, plus theme files and stylesheets that change
how T3 Code looks. It runs no code.

The plugins in [`fixtures/`](./fixtures) back the tests and are small and working too. They are
written by hand and need no build.

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
  `>=0.1.6`. A server outside it refuses to install the plugin or start it, and says why.
- `permissions` is an optional list of what the plugin says it uses. Settings → Plugins shows it on
  the plugin's row, and T3 Code doesn't enforce it.
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
- **Ask for a seam.** When T3 doesn't hand over what you need, ask for a region or token on the
  T3 Code repository instead of reaching into its markup.

## Developing a plugin

Add the plugin's folder to `devPaths` in `plugins.json` in the T3 Code data directory, turn the
plugin on in Settings → Plugins, and use **Reload** after each change. **Unlink** on its row removes
it from `devPaths` and leaves the folder alone. A linked folder whose id an installed plugin already
has fails as a duplicate, so remove the installed copy first.

To install a finished plugin, drag its folder onto Settings → Plugins, or use **Add plugin** to
choose it. Unlink a linked copy first. It installs turned off, so turn it on on its row.
