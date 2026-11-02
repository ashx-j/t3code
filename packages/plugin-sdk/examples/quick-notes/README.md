# Quick notes

Short notes kept by the plugin's server half, so every device connected to the environment sees
the same list. The latest 3 show in a sidebar section under the thread list. "All notes" opens the
plugin's page beside the sidebar, where you add and remove notes. Typing `@` in the composer offers
the notes too; picking one adds it to the message as a chip.

Install it from **Settings → Plugins → Add plugin** with this folder's path.

It uses `sidebar.addSection`, `pages.register`, `composer.setMentionItems`, `rpc.invoke` and
`rpc.subscribe` on the web side,
and `rpc.register`, `rpc.publish` and `storage` on the server side.
