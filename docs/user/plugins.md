# Plugins

Plugins change how T3 Code looks, with themes. A plugin belongs to one environment and lives on
that environment's T3 Code server. A plugin's row lists the permissions it says it uses, but T3
Code doesn't enforce them.

## Add a plugin

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default. A folder with the same plugin id as one you already have doesn't run, and its row names
the folder that has that id.

**Settings → Plugins** shows one environment at a time, the main one until you pick another at the
top of the page. To use a plugin on several environments, add it to each of them.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. **Reload** restarts a plugin with its current
files.

## Themes

A plugin can change how T3 Code looks without running any code. Theme files in its `themes` folder
show up as themes while the plugin is on. Themes load from the app's main environment (see [Where
plugins live](#where-plugins-live)).

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin, and `plugins.json` records which ones are enabled.

Plugin themes load in the web and desktop apps, from the app's main environment: the desktop app's
own server, or the server the web app was opened from. app.t3.codes and a desktop app with its local
environment turned off have no main environment, so they load no plugin themes. The mobile app
doesn't show plugin settings or themes.
