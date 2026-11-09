# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) finds plugins, keeps them on or off
and publishes their themes.

## Manifests

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin requires a newer T3: the server refuses to start a version outside it.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags and dev paths. They stay out of `settings.json`, whose
writer drops keys it doesn't know, and out of `statev2.sqlite`, whose numbered migrations refuse to
start when a fork's id collides with an upstream one.

## Installing

Discovery takes the id from the manifest, because people copy plugin folders in by hand. The
enabled flag belongs to the id, so a later folder with an id already listed fails as a duplicate.
Installed folders come first, in name order, then dev paths. Discovery also forgets the enabled flag
of every id no folder has, so a folder copied in later with that id starts off. Nothing watches
`plugins/`: the server reads it at startup, on reload and when Settings asks.

## Clients

Each browser keeps its own choice of the environments it loads plugin styles and themes from, the
main one by default.

With no plugins, the plugin system adds about 5.7 KB of minified JS to the startup chunks of a
production build, about 2.1 KB gzipped, and no new chunks. Most of it is the plugin contract
schemas and RPC definitions,
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx) and `pluginFollow`.
Once the app is idle, the starter downloads a 1.2 KB watcher and follows `plugins.subscribeStates`
for each chosen environment, a stream of its own because the server config stream would resend the
whole config on every plugin change. It downloads a small styles chunk only when an active plugin
has a `styles/` folder. The server starts plugins after it is listening. The mobile app shows no
plugin settings, styles or themes.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The server marks plugin themes, so the client
can show only those of chosen environments. The desktop main process cannot read localStorage, so
the page sends it the canvas it paints under a light and a dark native theme.
