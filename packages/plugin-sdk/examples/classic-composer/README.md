# Classic composer

A web-only plugin that brings back the composer row from before T3's redesign. The model, effort
and permissions pickers sit on the left, each ending in a chevron, and attach and send sit on the
right, 16px in from the card's edges. Full access shows an open lock. As the composer narrows,
permissions and then effort drop their labels, and on the narrowest screens the row hands over to
T3's own row, which folds them into a menu. A new thread's workspace and branch sit in a drawer
tucked under the card. Scrolling the timeline up rests an existing thread's composer as one line;
focusing it or scrolling back to the end expands it. The plugin's **Settings** button on the
Plugins page turns that off on this device.

Install it by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose
folder**. Turning it off brings back T3's current composer.

It uses `api.ui.replace("composer.controls", …)`, so it only arranges T3's own pickers and buttons,
`api.composer.setCollapseOnScroll`, which turns on T3's own folded composer from phones, and
`api.settings.registerPanel` for the switch, which it keeps in this browser's local storage.
Rebuild `web.js` after editing `web.tsx` with
`vp build --config examples/classic-composer/vite.config.ts` from `packages/plugin-sdk`.

## What it hardcodes

The row's layout and folding steps only touch the plugin's own elements. The rules below reach
into T3's markup because T3 has no seam for them, each through the most stable hook it has. If T3
renames a hook, that rule stops matching and T3's own look shows in its place. When T3 adds the
seam, move the rule to it.

| Rule                                                                                                                                | Hook it relies on                                                                                                                                             | Seam that would replace it                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On the narrowest screens, T3's own row, the only one that folds into a menu, gets the classic order                                 | `data-chat-composer-actions="right"` and `data-chat-composer-controls="footer"`, which T3's composer code reads                                               | `composer.controls` handing over `compact: boolean` and a `menu` piece                                                                                                           |
| Effort and permissions drop their labels as the row narrows                                                                         | `data-composer-control-label` on the pickers' labels                                                                                                          | The same `compact` flag, or an `iconOnly` prop on the `effort` and `access` pieces                                                                                               |
| The pickers end in a chevron, 8px in from their edge, and the model's name never truncates                                          | `data-chat-provider-model-picker`, and `data-composer-shortcut`, which T3's keyboard shortcuts use                                                            | `@t3tools/plugin-sdk/icons` exporting T3's icons, and `model`, `effort` and `access` as components taking `{ endIcon?: WebPluginNode }`                                          |
| Full access shows an open lock                                                                                                      | The `lucide-shield-off` class on T3's icon, the only thing that marks it                                                                                      | `api.ui.replaceIcon("access.full-access", Icon)` with typed icon names                                                                                                           |
| A new thread's workspace and branch sit in a drawer tucked under the card, with chevrons, and the drawer doesn't repeat Full access | `data-slot="composer-context-strip"`, `data-composer-context-control`, `data-slot="combobox-trigger"`, and the permissions chip's `aria-label`, its only mark | A `composer.context` part with `workspace`, `pullRequest`, `branch` and `access` pieces, and documented `--composer-surface`, `--composer-border` and `--composer-radius` tokens |
| The card's outline and fill open where the drawer joins it, so no hairline crosses the join                                         | `data-context-row` on `data-slot="composer-shell"`, and the outline and fill on `data-slot="composer-host"` and `data-chat-composer-main-surface`             | The same `composer.context` part drawing the join, or a `--composer-outline-clip` token                                                                                          |
| On a narrow screen the prompt sits 12px in from the card's edge, like the row                                                       | `data-chat-composer-body`, which T3's resting animation reads                                                                                                 | A `--composer-inset` token, or `composer.controls` handing over `compact` so the plugin can set it                                                                               |
| The paperclip sits 1px higher                                                                                                       | The `lucide-paperclip` class on T3's attach icon, inside this plugin's row                                                                                    | `@t3tools/plugin-sdk/icons` exporting T3's icons, so the plugin can pass its own `attach` icon                                                                                   |

The chevron and open lock are copies of Lucide's `chevron-down` and `lock-open` paths, drawn as CSS
masks, until T3 shares its icons.
