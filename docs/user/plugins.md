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

The plugin is enabled and started once it is installed. If installing over an existing version
fails, the previous version keeps running.

An agent can also install a plugin when you ask it to, with the `t3_plugins_install` tool. Like
other changes to the environment, it needs a session with full access.

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

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin. Their settings are in `plugin-data`, and `plugins.json` records which ones are
enabled.

Plugins that draw web UI load in the web and desktop apps. Connections through T3 Connect cannot
load plugin UI yet. The mobile app shows plugin themes, but not plugin UI or plugin settings.
