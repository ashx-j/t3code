# Message extras

A web-only plugin that redraws parts of the timeline. Each finished assistant message gets a word
count under it, and an expanded command shows as a plain terminal block with its output. Other
kinds of agent steps keep T3's own drawing.

Install it from **Settings → Plugins → Add plugin** with this folder's path.

It replaces the `message.assistant` and `timeline.item` parts and places T3's `original` drawing
where it wants to keep it.
