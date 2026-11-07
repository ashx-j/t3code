# Message extras

A web-only plugin that redraws parts of the timeline and the diff panel. Each finished assistant
message gets a word count under it, an expanded command shows as a plain terminal block with its
output, and the diff panel gets a line with the number of files and lines changed above T3's own
diffs. Other kinds of agent steps keep T3's own drawing.

First build its web half with `vp run build:examples` in `packages/plugin-sdk`. Then install it
by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose folder**.

It replaces the `message.assistant`, `timeline.item` and `diff.view` parts and places T3's `original` drawing
where it wants to keep it.
