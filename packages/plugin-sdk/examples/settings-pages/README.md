# Settings pages

A web-only plugin that opens Settings and Usage as pages in place of the thread, beside the
sidebar, instead of a window over the chat. Settings lists its sections where the thread list was.
Back at the bottom of the sidebar and Esc go back to the thread. On phones, and while the sidebar
is closed, the pages keep T3's close button.

Install it from **Settings → Plugins → Add plugin** with this folder's path.

It replaces the `app.pageFrame` part with the `page` piece T3 hands it plus its own Back button. A
stylesheet moves the sections into the sidebar's place, which a T3 update to that markup can undo.
Rebuild `web.js` after editing `web.tsx` with
`vp build --config examples/settings-pages/vite.config.ts` from `packages/plugin-sdk`.
