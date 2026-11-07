# Surface

Surface's look. In dark mode: neutral grays, a #151515 background, #191919 cards, #1e1e1e raised
rows, a near-white main button and color only where something needs attention. Borders and hover
fills are translucent white, so they read the same on the canvas, cards and rows. Light mode keeps
T3's own light colors, like Surface itself does. Both modes get Surface's 0.625rem corners and its
shapes: thread details cards, solid settings groups, framed segmented tabs and a square stop
button. Chat code blocks, banners, the composer's menus and the chat header's buttons keep the
look they have without a theme.

Install it by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose
folder**, then pick **Surface** under **Settings → Appearance → Themes**. It covers light, dark
and following the system.

T3 Code remembers the theme once it has seen it, so later starts paint the boot screen, and on
desktop the window, #151515 from the first frame instead of black. `"sidebarArtwork": true` keeps
the nightly and dev artwork in the sidebar's corner.

`themes/surface.json` holds every color for both modes, the corner radius and the dark status
colors. Its light colors are T3's light mode as T3 paints it, which differs from T3's shared
palette in its text colors, the raised surface and the error and warning fills. `web.js` adds the
shapes a theme file can't set yet. Its rules apply only while the Surface theme is on, so picking
another theme brings back T3's own look. The theme file also imports on its own through **Add
theme**, which keeps its colors but not its corner radius, status colors or `web.js` shapes.
Duplicating Surface in the theme editor gives the copy a new id, so the copy loses the `web.js`
shapes too.

## What `web.js` hardcodes

T3 has no seam for these, so each rule reaches into T3's markup through the most stable hook it
has. If T3 renames a hook, that rule stops matching and T3's own look shows in its place. When T3
adds the seam, move the rule to it.

| Rule                                                                                                                                          | Hook it relies on                                                                                                                                                                           | Seam that would replace it                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons, inputs, pickers and sidebar rows use the 0.625rem radius                                                                             | T3's `--control-radius` variable                                                                                                                                                            | The theme's `radius` also setting `--control-radius`, or a `controlRadius` field                                                        |
| The sidebar's edge is the hairline border in both modes. In dark its background, cards and hover fill use the sidebar gray                    | T3's `--background`, `--card` and `--accent` variables inside `[data-app-sidebar]`, and T3's `dark` class on the root                                                                       | T3 using the `sidebarBorder` role for a theme's sidebar edge, and mapping those variables to the `sidebar` and `sidebarRowActive` roles |
| The composer card keeps T3's own fill, outline and top highlight in each mode                                                                 | `--chat-composer-glass-surface`, `--chat-composer-outline` and `--chat-composer-highlight` on `data-slot="composer-shell"`                                                                  | Theme roles `composerSurface`, `composerOutline` and `composerHighlight`                                                                |
| Banners and the `/`, `@` and `$` menus above the composer keep T3's own fill in light and, except errors and warnings, its edge in both modes | `--chat-composer-attached-surface` and `--chat-composer-attached-outline` on `data-composer-banner-surface`, and its `data-variant`                                                         | The same `composerSurface` and `composerOutline` roles reaching the banners                                                             |
| Tool errors keep T3's own icon color, red in light and light red in dark                                                                      | T3's `--tool-error-icon` variable                                                                                                                                                           | A `toolErrorIcon` theme role                                                                                                            |
| Thread details shows one card per section, rows on a raised layer, with the composer's shadow                                                 | `data-thread-details-card`, its `section` elements, and the `border-border/65` class on divided sections                                                                                    | A `thread.details` part with `sections: ReadonlyArray<{ id; title; actions; rows }>` and `mode: "panel" \| "popover"`                   |
| Grouped settings are solid cards, except the provider detail pane's flat sections                                                             | `data-slot="settings-group"`, the grouped variant's `bg-card/40` class, and `data-provider-detail`                                                                                          | Theme component colors such as `settingsGroup: { surface, border }`                                                                     |
| Segmented tabs have a framed track. In dark it is sunken with a raised selected tab                                                           | `data-slot="toggle-group"` with `data-variant="segmented"`, and `data-variant` on its tabs, which a tooltip trigger keeps when it replaces their `data-slot`                                | Theme component colors such as `segmented: { track, thumb }`                                                                            |
| The stop button is a dim rounded square with a red icon                                                                                       | The button's `aria-label="Stop generation"`, its only mark                                                                                                                                  | Theme component colors such as `stopButton: { surface, icon, shape }`, or a `data-slot` on the button                                   |
| Chat code blocks keep their own gray fill and edge instead of the theme's code colors                                                         | The `chat-markdown-codeblock` class inside `.chat-markdown` and `.composer-tiptap`, and `revert-layer` back to its own classes                                                              | A `codeBlock` theme role, or T3 tinting code blocks only for themes that ask for it                                                     |
| Buttons and menus in the chat header keep their own fill, edge and icon color, so a ghost button stays ghost                                  | `data-chat-header` with `data-slot="button"`, `data-slot="menu-trigger"` and `data-toolbar-control`, T3's own selectors for the themed header, and `revert-layer` back to their own classes | T3 theming the header's controls only for themes that ask for it, or theme roles for header controls                                    |

The cards, tabs and stop button read Tailwind's `--radius-lg`, `--radius-xl` and `--radius-2xl`,
and thread details' headings read `--text-xs` and `--text-xs--line-height`. Tailwind emits those
tokens only while T3's own code uses them, so each falls back to T3's value. A theme token list in
the SDK would replace them.
