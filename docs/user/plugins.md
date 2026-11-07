# Plugins

Plugins change how T3 Code looks, with themes and styles. A plugin belongs to one environment and
is installed on that environment's T3 Code server. A plugin's row lists the permissions it says it
uses, but T3 Code doesn't enforce them. Install only plugins you trust.

## Add a plugin

Open **Settings → Plugins** and drag a plugin's folder onto the page. **Add plugin** also lets you
choose the folder in a file window.

T3 Code copies a plugin folder into the environment's `plugins` folder, so later changes to your
copy do not affect the installed plugin. To update it, add the new version's folder the same way.
The plugin is enabled and started once it is installed. If installing over an existing version
fails, the previous version keeps running. A plugin that needs a newer version of T3 Code isn't
installed, and T3 Code says why.

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default.

A plugin only changes the app, so with **All environments** selected it is installed only on the
app's main environment (see [Where plugins live](#where-plugins-live)). The list shows each plugin
once, and turning it on or off or removing it applies to every environment that has it.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. **Reload** restarts a plugin with its current
files.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm in the popup.

A plugin loaded from its own folder shows **Unlink** instead. Unlinking stops loading it and leaves
the folder where it is.

## Themes and styles

A plugin can change how T3 Code looks without running any code. Theme files in its `themes` folder
show up as themes while the plugin is on. CSS files in its `styles` folder apply to the app
while the plugin is on, on top of T3 Code's own styles and your theme. A plugin can be just a
`styles` folder and its manifest.

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin, and `plugins.json` records which ones are enabled.

Plugin styles load in the web and desktop apps, from the app's main environment: the desktop app's
own server, or the server the web app was opened from. app.t3.codes and a desktop app with its
local environment turned off have no main environment, so they load no plugin styles.

Plugins on other environments you connect show in **Settings → Plugins**, but their styles don't
load. The mobile app doesn't show plugin settings, styles or themes.
