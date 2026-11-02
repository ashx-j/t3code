# Classic composer

A web-only plugin that brings back the composer row from before T3's redesign. The model, effort
and permissions pickers sit on the left, and attach and send sit on the right, 16px in from the
card's edges. Scrolling the timeline up rests an existing thread's composer as one line with its
pickers under it; focusing it or scrolling back to the end expands it. The plugin's **Settings**
button on the Plugins page turns that off on this device.

Install it from **Settings → Plugins → Add plugin** with this folder's path. Turning it off brings
back T3's current composer.

It uses `api.ui.replace("composer.controls", …)`, so it only arranges T3's own pickers and buttons,
`api.composer.setCollapseOnScroll`, which turns on T3's own folded composer from phones, and
`api.settings.registerPanel` for the switch, which it keeps in this browser's local storage. Its
stylesheet only reaches the plugin's own elements. Rebuild `web.js` after editing `web.tsx` with
`vp build --config examples/classic-composer/vite.config.ts` from `packages/plugin-sdk`.
