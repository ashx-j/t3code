# Review flags

A web-only plugin that shows the places a plugin can add buttons and badges. "Flag for review"
buttons sit under each message, in the thread header and beside the composer's attach button.
Each one puts a Review badge on the thread's sidebar row and header. "Clear review flag" in the
thread's actions menu removes it. Flags are kept in memory, so they clear when the app reloads.

First build its web half with `vp run build:examples` in `packages/plugin-sdk`. Then install it
by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose folder**.

It uses `messages.addAction`, `threads.addHeaderButton`, `composer.addButton`,
`threads.addMenuItem` and `threads.setBadge`.
