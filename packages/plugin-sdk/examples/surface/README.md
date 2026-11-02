# Surface

A web-only plugin with a dark theme and a stylesheet. The theme is neutral grays: a #151515
background, #191919 cards, #1e1e1e raised rows and a near-white main button. The stylesheet makes
borders and hover fills translucent white, rounds corners a little more, turns each thread details
section into its own card, gives segmented tabs a sunken track and makes the stop button a dark
square with a red icon.

Install it from **Settings → Plugins → Add plugin** with this folder's path, then pick **Surface**
under **Settings → Appearance → Themes** and switch the color scheme to Dark. The stylesheet only
applies while the Surface theme is in use, so picking another theme brings back T3's own look.

It uses a `themes/` folder and `api.injectStyles`. The stylesheet targets T3's own markup, so a T3
update that changes those elements can undo parts of it.
