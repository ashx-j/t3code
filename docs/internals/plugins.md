# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process, with
no sandbox. Manifest `permissions` are shown on the plugin's row and not enforced. Do not shape the
API around a future sandbox.

The host isolates failure instead. A plugin that throws or hangs while starting is marked failed,
and a throw in a handler fails that call.

Plugin code can still fail where nothing T3 runs is waiting, such as in a timer or a child process
with no `'error'` listener. The [failure guard](../../apps/server/src/plugins/pluginFailureGuard.ts)
ties such a failure to a plugin when it can. A plugin's unhandled rejection becomes that plugin's
`serverFailure`, and Node does not exit. The plugin stays active. Disabling or reloading it releases
what it registered through the API, but timers it started itself keep running, and Node keeps its
code until the server restarts. This is accepted because the user chose to install that code, and
the alternative is one plugin bug stopping the server and every running agent.

An uncaught exception still stops the server, because Node calls resuming after one unsafe. When the
guard ties one to a plugin, it saves the error to `plugins.json` before Node exits. The next start
lists that plugin as failed with its switch off until the user turns it on again, so a plugin that
throws at startup can't stop every start. A failure the guard can't tie to a plugin
stops the server too.

The host runs plugin code in an `AsyncLocalStorage` scope, which Node carries into the timers and
callbacks that code starts, so a failure with only Node's frames in its stack is still the plugin's.
Before Node 24 that scope slows every promise in the process about 3x, so the host fails plugins
with a server half there as incompatible, though the server still allows Node 22.16+ and 23.11+.
Plugins without one still run.

## The API and manifests

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AbortSignal` and the SDK's own types, never T3's contracts, which
change between releases.

`plugins.invoke` and `plugins.subscribe` need only the read scope, so the host checks a method's
`access` itself: a `write` method needs the caller's operate scope, as T3's own changes do. A call
fails after 30 seconds and aborts the handler's signal, so a handler that never answers can't hold
a client's call open. Each subscriber gets its own sliding buffer per channel, so a busy channel or
a slow subscriber drops only that channel's oldest values.

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin requires a newer T3: the server refuses to install or start a version
outside it. `api.version` is how a plugin detects newer API members and still runs on older
releases, so a change that adds a member raises it and names that version in the member's doc.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags, dev paths and the plugins that stopped the server.
They stay out of `settings.json`, whose writer drops keys it doesn't know, and out of
`statev2.sqlite`, whose numbered migrations refuse to start when a fork's id collides with an
upstream one.

## Installing

Installs copy into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock, so a slow copy does not block other plugins. The
old version waits in staging until the new one starts and goes back if it fails.

Clients upload a dropped folder's files, never its path, which would mean nothing on a remote
environment. They post them over HTTP to a URL `plugins.createUploadUrl` signs for 5 minutes,
because one large WebSocket message holds up every other stream on the socket. As for attachments,
the signature is the credential, so the upload works the same on every kind of connection. Each URL
installs once. The server keeps its unused URLs in memory, so a restart refuses those it signed
before.

Discovery takes the id from the manifest, because people copy plugin folders in by hand. The enabled
flag belongs to the id, so a later folder with an id already listed fails as a duplicate. Installed
folders come first, in name order, then dev paths. Removing or unlinking a duplicate deletes only
its folder or link. Discovery also forgets the enabled flag and crash record of every id no folder
has, so a folder copied in later with that id starts off. Nothing watches `plugins/`: the server
reads it at startup, on reload and when Settings asks.

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
