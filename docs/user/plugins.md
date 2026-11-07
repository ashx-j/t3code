# Plugins

Plugins add features to T3 Code: panels, commands, themes, styles, agent tools and more. A plugin
belongs to one environment and runs inside that environment's T3 Code server, with the same
access to your files, threads and credentials as T3 Code itself. A plugin's row lists the
permissions it says it uses, but T3 Code doesn't enforce them. Install only plugins you trust.

## Add a plugin

Open **Settings → Plugins** and drag a plugin's folder onto the page. **Add plugin** also lets you
choose the folder in a file window.

T3 Code copies a plugin folder into the environment's `plugins` folder, so later changes to your
copy do not affect the installed plugin. To update it, add the new version's folder the same way.
The plugin is enabled and started once it is installed. If a new version fails to install or start,
you keep the version you had, and T3 Code says why. A plugin that needs a newer version of T3 Code
isn't installed, and T3 Code says why.

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default.

With **All environments** selected, a plugin is installed on every connected environment that can
run plugins. A plugin with no server code or agent skills only changes the app, so it goes only to
the first environment you load plugin UI from (see [Where plugins live](#where-plugins-live)). The
list then shows each plugin once, and turning it on or off, changing its settings or removing it
applies to every environment that has it.

With **Plugin tools for agents** on in **Settings → Plugins**, agents can also install, remove, turn
on and off, call and change the settings of plugins when you ask them to. Only an agent in a thread
set to **Full access**, and not in Plan mode, can do this, or an outside agent you approved with
**Full access**. Agents from linked environments can't. Any agent can read a plugin's settings, with
secrets hidden. T3 Code checks the thread's permission mode, not whether the person who started the
thread may change Settings. The switch is off until you turn it on. If your browser loads plugin UI
from that environment, a plugin an agent installs there can run code in your browser, with access to
every environment your browser is connected to.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. **Reload** restarts a plugin with its current
files. Turning a plugin off doesn't stop code it started on its own, such as a timer. If its row
says some of its code is still running, restart T3 Code to stop it.

## Plugin settings

If a plugin has settings, open them with the settings button on its row. Each setting saves as soon
as you change it or leave its field, and an empty field shows the default the plugin uses. Secret
fields are stored in the environment's secret store and are never shown again after you save them;
the clear button next to one removes it.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm in the popup. Removing a plugin also deletes its
settings, secrets and stored data, and this can't be undone. Reinstalling it later starts fresh.

A plugin loaded from its own folder, such as one an agent is writing, shows **Unlink** instead.
Unlinking stops loading it and deletes its settings, secrets and stored data the same way, but
leaves the folder where it is.

## Themes and styles

A plugin can change how T3 Code looks without running any code. Theme files in its `themes` folder
show up as themes while the plugin is on. CSS files in its `styles` folder apply to the app while
the plugin is on, on top of T3 Code's own styles and your theme. A plugin can be just a `styles`
folder and its manifest. Themes and styles load from the same environments as plugin UI (see [Where
plugins live](#where-plugins-live)).

## Plugins in your threads

A plugin can answer an agent's approval requests and questions for you, for example to allow
commands you always allow. The request still appears in the thread, and you can answer it yourself
while the plugin decides. If no plugin answers within a few seconds, it waits for you as usual.

A plugin can also change a message before it is sent, or stop it and say why. A stopped message
stays in the composer, so you can edit it and send it again. Slash commands are never changed or
stopped by plugins.

Plugins can add slash commands. They appear in the composer's `/` menu with the agent's own
commands. A command that runs on the server shows in every app, and one that runs in the app shows
in the web and desktop apps. A command can send the agent a message the plugin prepares, or stop
with a reason. The agent's own command wins over a plugin's with the same name. Between plugins, a
command that runs on the server wins over one that runs in the app, and otherwise the plugin whose
id comes first alphabetically gets it.

A plugin can give Claude and Codex agents extra instructions and skills while the plugin is on. Its
skills appear in the composer's `$` menu with the plugin's name for those agents. Codex gets changes
on its next turn. A Claude thread that is already running keeps the instructions and skills it
started with until T3 Code starts Claude again for it, such as after T3 Code restarts. Picking a
skill from a newly added plugin starts Claude again for that message. Other agents don't get plugin
instructions or skills yet.

A plugin can give agents new tools. Agents in threads started after you turn the plugin on see them.
Turning the plugin off takes its tools away from every thread. Tools that only read work in any
thread. Tools that change things work only in a thread set to **Full access** and not in Plan mode,
the same as the plugin management tools above.

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin. Their settings are in `plugin-data`, and `plugins.json` records which ones are
enabled.

Plugin UI, styles and themes load in the web and desktop apps. They load from the app's main
environment, which is the desktop app's own server or the server the web app was opened from, and
from any other environment you turn on under **Load plugin UI from** in **Settings → Plugins**. You
can turn the main environment off there too. app.t3.codes and a desktop app with its local
environment turned off have no main environment, so no plugin UI loads until you choose one. The
choice applies to this browser only. Each chosen environment's plugins run code in this window, with
access to every environment this window is connected to, so choose only environments whose plugins
you trust.

Buttons, menu items, badges, slash commands that run in the app, `@` items, banners, right panels,
tool views and replaced parts of the app show only in the threads of the plugin's own environment.
Code blocks a plugin draws show in every thread. Pages, sidebar sections and command palette
commands come from only one chosen environment, the main one unless you turn it off. When you choose
more than one, **Load plugin UI from** says which. The mobile app doesn't show plugin UI, settings
or themes, and a plugin page's `t3code://plugins/...` link opens only in the desktop and web apps.
