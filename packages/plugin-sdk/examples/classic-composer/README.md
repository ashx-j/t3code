# Classic composer

A web-only plugin that brings back the composer row from before T3's redesign. The model, effort
and permissions pickers sit on the left, each with a chevron. Attach and send sit on the right.

Install it from **Settings → Plugins → Add plugin** with this folder's path. Turning it off brings
back T3's current row.

It uses `api.ui.replace("composer.controls", …)`, so it only arranges T3's own pickers and buttons.
The pickers keep working the same way when T3 changes them. Rebuild `web.js` after editing
`web.tsx` with `vp build --config examples/classic-composer/vite.config.ts` from
`packages/plugin-sdk`.
