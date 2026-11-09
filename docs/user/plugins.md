# Plugins

Plugins add themes, styles and server code to T3 Code. A plugin belongs to one environment and runs
inside that environment's T3 Code server, with the same access to your files, threads and
credentials as T3 Code itself. A plugin's row lists the permissions it says it uses, but T3 Code
doesn't enforce them. Install only plugins you trust.

## Add a plugin

Open **Settings → Plugins** and drag a plugin's folder onto the page. **Add plugin** also lets you
choose the folder in a file window.

T3 Code copies a plugin folder into the environment's `plugins` folder, so later changes to your
copy do not affect the installed plugin. To update it, add the new version's folder the same way.
A new plugin is installed turned off, so none of it runs until you have read its row and turned it
on. A new version of a plugin stays on or off as the old one was. If a new version fails to install
or start, you keep the version you had, and T3 Code says why. A plugin that needs a newer version
of T3 Code isn't installed, and T3 Code says why.

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default. A folder with the same plugin id as one you already have doesn't run, and its row names
the folder that has that id. Remove one of them.

**Settings → Plugins** shows one environment at a time, the main one until you pick another at the
top of the page. To use a plugin on several environments, add it to each of them.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. A plugin with server code needs the environment's
T3 Code server to run on Node 24 or later, as the desktop app's does. **Reload** restarts a plugin
with its current files. Turning a plugin off doesn't stop code it started on its own, such as a
timer. If its row says some of its code is still running, restart T3 Code to stop it.

A plugin can stop T3 Code's server with an error. When the server starts again, that plugin stays
off and its row says it stopped the server. To try it again, turn it back on.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm in the popup.

A plugin loaded from its own folder shows **Unlink** instead. Unlinking stops loading it and leaves
the folder where it is.

On a duplicate's row, **Remove** deletes only that folder and **Unlink** only stops loading it. The
plugin in use keeps running.

## Themes and styles

A plugin can change how T3 Code looks without running any code. Theme files in its `themes` folder
show up as themes while the plugin is on. CSS files in its `styles` folder apply to the app while
the plugin is on, on top of T3 Code's own styles and your theme. A plugin can be just a `styles`
folder and its manifest. Themes and styles load from the same environments as plugin UI (see [Where
plugins live](#where-plugins-live)).

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin, and `plugins.json` records which ones are enabled.

Plugin styles and themes load in the web and desktop apps. They load from the app's main
environment, which is the desktop app's own server or the server the web app was opened from, and
from any other environment you turn on under **Load plugin UI from** in **Settings → Plugins**. You
can turn the main environment off there too. app.t3.codes and a desktop app with its local
environment turned off have no main environment, so no plugin styles or themes load until you
choose one. The choice applies to this browser only.

The mobile app doesn't show plugin settings, styles or themes.
