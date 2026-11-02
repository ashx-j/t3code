# Classic composer

A web-only plugin that brings back the composer from before T3's redesign. The model, effort and
permissions pickers sit on the left, each with a chevron, and Full access shows an open lock.
Attach and send sit on the right. A new thread's workspace and branch sit in a drawer under the
card instead of a plain row. Scrolling the timeline up folds the composer to one line with its
pickers resting under it; focusing it or scrolling back to the end unfolds it.

Install it from **Settings → Plugins → Add plugin** with this folder's path. Turning it off brings
back T3's current composer.

It uses `api.ui.replace("composer.controls", …)`, so it only arranges T3's own pickers and buttons,
and `api.composer.setCollapseOnScroll(true)`, which turns on T3's own folded composer from phones.
The pickers keep working the same way when T3 changes them. The drawer, the spacing and the lock
come from a stylesheet on T3's markup, which a T3 update can undo. Rebuild `web.js` after editing
`web.tsx` with `vp build --config examples/classic-composer/vite.config.ts` from
`packages/plugin-sdk`.
