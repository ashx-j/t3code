# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process, with
no sandbox. Manifest `permissions` are shown on the plugin's row and not enforced, and
`settings.get()` and `secrets.request` hand plugins secret values in plain text. Do not shape the
API around a future sandbox.

The host isolates failure instead. A plugin that throws or hangs while starting is marked failed,
and a throw in a handler fails that call. Node exits on a rejection nobody handles, so every promise
the API hands a plugin comes from `call` or `refused` in
[`facade.ts`](../../apps/server/src/plugins/api/facade.ts), which mark it handled.

Plugin code can still fail where nothing T3 runs is waiting, such as in a timer or a child process
with no `'error'` listener. The
[failure guard](../../apps/server/src/plugins/pluginFailureGuard.ts) catches the uncaught exception
or unhandled rejection. When it ties one to a plugin, it records it as that plugin's
`serverFailure` and returns, so Node does not exit. The throw has unwound only the callback that
ran plugin code. The plugin stays active. Disabling or reloading it releases what it registered
through the API, but timers it started itself keep running, and Node keeps its code until the
server restarts. This is accepted because the user chose to install that code, and the alternative
is one plugin bug stopping the server and every running agent. A failure the guard can't tie to a
plugin still stops the server.

On Node 24 and later, the host runs plugin code in an `AsyncLocalStorage` scope, which Node carries
into the timers and callbacks that code starts, so a failure with only Node's frames in its stack
is still the plugin's. Before Node 24 that tracking slows every promise in the process about 3x, so
it is off there and the guard goes by plugin API errors and stack frames alone. A plugin failure
with only Node's frames then stops the server. The server still allows Node 22.16+ and 23.11+.

## The API and manifests

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams and `AbortSignal`.

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin asks for a newer T3: the server refuses to install or start a version
outside it.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags and dev paths. Settings go in `plugin-data/<id>/` and
storage in `plugins.sqlite`. They stay out of `settings.json`, whose writer drops keys it doesn't
know, and out of `statev2.sqlite`, whose numbered migrations refuse to start when a fork's id
collides with an upstream one. Settings stay out of `plugins/<id>/`, so replacing a plugin's files
keeps them.

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

Plugin styles load from the main environment, so Settings installs a plugin with no server code on
that environment alone. Once the app is idle,
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx) follows the state
stream and downloads a small styles chunk only when an active plugin has a `styles/` folder. The
server starts plugins after it is listening. The mobile app shows no plugin settings, styles or
themes.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The desktop main process cannot read
localStorage, so the page sends it the canvas it paints under a light and a dark native theme.

## Reaching into orchestration

`threads.notify` is its own internal command in `Orchestrator.ts`, because every `message.dispatch`
starts a run.
