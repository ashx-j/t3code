# Surface

A dark theme with Surface's look: neutral grays, a #151515 background, #191919 cards, #1e1e1e raised
rows, a near-white main button, 0.625rem corners and color only where something needs attention.
Borders and hover fills are translucent white, so they read the same on the canvas, cards and rows.

Install it by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose
folder**, then pick **Surface** under **Settings → Appearance → Themes** and switch the color scheme
to Dark.

T3 Code remembers the theme once it has seen it, so later starts paint the boot screen, and on
desktop the window, #151515 from the first frame instead of black. `"sidebarArtwork": true` keeps
the nightly and dev artwork in the sidebar's corner.

`themes/surface.json` holds every color, the corner radius and the status colors. `web.js` adds the
shapes a theme file can't set yet. Its rules apply only while the Surface theme is on, so picking
another theme brings back T3's own look.

## What `web.js` hardcodes

T3 has no seam for these, so each rule reaches into T3's markup through the most stable hook it
has. If T3 renames a hook, that rule stops matching and T3's own look shows in its place. When T3
adds the seam, move the rule to it.

| Rule                                                                                      | Hook it relies on                                                                                        | Seam that would replace it                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Buttons, inputs, pickers and sidebar rows use the 0.625rem radius                         | T3's `--control-radius` variable                                                                         | The theme's `radius` also setting `--control-radius`, or a `controlRadius` field                                      |
| The sidebar's background, cards and hover fill use the sidebar gray, with a 6% white edge | T3's `--background`, `--card` and `--accent` variables inside `[data-app-sidebar]`                       | T3 mapping those in the sidebar to the `sidebar`, `sidebarRowActive` and `sidebarBorder` roles                        |
| The composer card's outline and top highlight are plain white hairlines                   | `--chat-composer-outline` and `--chat-composer-highlight` on `data-slot="composer-shell"`                | Theme roles `composerOutline` and `composerHighlight`                                                                 |
| Tool errors keep a light red icon                                                         | T3's `--tool-error-icon` variable                                                                        | A `toolErrorIcon` theme role                                                                                          |
| Thread details shows one card per section, rows on a raised layer                         | `data-thread-details-card`, its `section` elements, and the `border-border/65` class on divided sections | A `thread.details` part with `sections: ReadonlyArray<{ id; title; actions; rows }>` and `mode: "panel" \| "popover"` |
| Grouped settings are solid cards                                                          | `data-slot="settings-group"` and the grouped variant's `bg-card/40` class                                | Theme component colors such as `settingsGroup: { surface, border }`                                                   |
| Segmented tabs have a sunken track and a raised selected tab                              | `data-slot="toggle-group"` with `data-variant="segmented"`, and `data-slot="toggle"`                     | Theme component colors such as `segmented: { track, thumb }`                                                          |
| The stop button is a dark rounded square with a red icon                                  | The button's `aria-label="Stop generation"`, its only mark                                               | Theme component colors such as `stopButton: { surface, icon, shape }`, or a `data-slot` on the button                 |
