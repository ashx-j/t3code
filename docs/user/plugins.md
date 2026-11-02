# Plugins

Plugins add features to T3 Code: panels, commands, themes, agent tools and more. A plugin
belongs to one environment and runs inside that environment's T3 Code server, with the same
access to your files, threads and credentials as T3 Code itself. Install only plugins you trust.

## Add a plugin

Open **Settings → Plugins**, choose **Add plugin**, and pick a source:

- **Folder on the server**: a folder on the machine that runs the environment, containing a
  `t3-plugin.json`. T3 Code copies it, so later changes to that folder do not affect the installed
  plugin.
- **Git repository**: a repository URL, with an optional branch or tag.
- **npm package**: a package name, with an optional version. T3 Code checks the download against
  the registry's integrity hash before installing it.

The plugin is enabled and started once it is installed. If installing over an existing version
fails, the previous version keeps running.

Once an environment has a plugin, agents can also install, remove, turn on and off, and call
plugins when you ask them to. Like other changes to the environment, this needs a session with
full access. Agents in an environment with no plugins don't see these tools, so the first plugin
comes from Settings.

## Update a plugin

Plugins added from Settings have **Update** on their row. It installs the plugin again from the
same folder, repository or package, and keeps the current version running if that fails. An npm
plugin without a pinned version updates to the package's latest version.

T3 Code checks plugins added from a git repository or npm once a day and marks the ones with a
newer version as **Update available**. **Check for updates** on the Plugins page checks now.
Plugins installed before this check existed show updates only after their next update.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. **Reload** restarts a plugin with its current
files.

## Plugin settings

If a plugin has settings, open them from its row. Secret fields are stored in
the environment's secret store and are never shown again after you save them.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm. Its settings and stored data are
kept unless you tick **Also delete its settings and stored data**, so reinstalling it later picks
up where it left off.

Plugins loaded from a development folder listed in `plugins.json` cannot be removed from Settings.
Remove the folder from `plugins.json` instead.

## Plugins in your threads

A plugin can answer an agent's approval requests and questions for you, for example to allow
commands you always allow. The request still appears in the thread, and you can answer it yourself
while the plugin decides. If no plugin answers within a few seconds, it waits for you as usual.

A plugin can also change a message before it is sent, or stop it and say why. A stopped message
stays in the composer, so you can edit it and send it again.

Plugins can add slash commands. They appear in the composer's `/` menu with the agent's own
commands, in every app. A plugin's command runs on the server. It can send the agent a message the
plugin prepares, stop with a reason, or answer you in the thread without asking the agent.

A plugin can give Claude and Codex agents extra instructions and skills, from their next turn or
session while the plugin is on. Its skills appear in the composer's `$` menu with the plugin's name
for those agents. Other agents don't get them yet.

A plugin can give agents new tools. Agents in threads started after you turn the plugin on see
them; a thread that is already running keeps the tools it started with.

A plugin can also write the text T3 Code usually generates with a model: thread titles, commit
messages, pull request titles and descriptions, branch names and review guides. When it has
nothing to offer, T3 Code generates the text as usual.

## Plugins that add agents

A plugin can add an agent provider. It appears in **Settings → Providers** while the plugin is on,
turned off at first like most providers; turn it on there to pick it in the composer. Turning the
plugin off removes the provider, except one you turned on or changed: that stays listed as
unavailable with its settings kept, and turning the plugin back on restores it. To run a second
copy with other settings, pick it in **Add provider**.

A plugin can also add a source control host. Its repositories are recognized like GitHub's or
GitLab's, and it appears under **Settings → Source control** with the name the plugin gives it.

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin. Their settings are in `plugin-data`, and `plugins.json` records which ones are
enabled.

Plugins that draw web UI load in the web and desktop apps, from the app's main environment: the
desktop app's own server, or the server the web app was opened from. Plugins on other environments
you connect show in **Settings → Plugins**, but their UI doesn't load. In the desktop app a plugin can also
add commands under **Plugins** in the menu bar or to a tray icon's menu, and shortcuts that work
while T3 Code is in the background. The tray icon shows only while a plugin uses it. The mobile app shows plugin themes, but not plugin UI or plugin settings.
