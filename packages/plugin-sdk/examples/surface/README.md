# Surface

A theme-only plugin with Surface's dark palette: neutral grays, a #151515 background, #191919
cards, #1e1e1e raised rows and a near-white main button. Borders and hover fills are translucent
white, so they read the same on the canvas, cards and rows.

Install it from **Settings → Plugins → Add plugin** with this folder's path, then pick **Surface**
under **Settings → Appearance → Themes** and switch the color scheme to Dark. `themes/surface.json`
also imports on its own through **Add theme**.

T3 Code remembers the theme once it has seen it, so later starts paint the boot screen, and on
desktop the window, #151515 from the first frame instead of black. `"sidebarArtwork": true` keeps
the nightly and dev artwork in the sidebar's corner.

It has no code or stylesheet. Every color is a theme color role, so it only depends on the theme
file format.
