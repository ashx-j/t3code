# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) loads plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them. Plugins change
how the app looks with theme files and stylesheets, and run no code.

## Manifests

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin asks for a newer T3: the server refuses to install or start a version
outside it.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags and dev paths, and installed plugins live in
`plugins/<id>/`. The flags stay out of `settings.json`, whose writer drops keys it doesn't know.

## Installing

Installs write into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock. The old version moves into staging for the swap and
is deleted with it, and startup puts back a version that a crash left there.

Clients send the files of a dropped folder, never its path, which would mean nothing on a remote
environment. Discovery takes the id from the manifest, because people copy plugin folders in by
hand. Nothing watches `plugins/`: the server reads it at startup, on reload and when Settings asks.

## Clients

Plugin state has its own stream, `plugins.subscribeStates`, because the server config stream would
resend the whole config on every plugin change.

Plugin styles load from the main environment, so Settings installs a plugin on that environment
alone. Once the app is idle,
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx) follows the state
stream and downloads a small styles chunk only when an active plugin has a `styles/` folder. The
server starts plugins after it is listening. The mobile app shows no plugin settings, styles or
themes.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The desktop main process cannot read
localStorage, so the page sends it the canvas it paints under a light and a dark native theme.
