# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process and web
bundles run as React code in the page with every connection's credentials, with no sandbox. Manifest
`permissions` are shown on the plugin's row and not enforced, and `settings.get()` hands plugins
secret values in plain text. Do not shape the API around a future sandbox.

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
instances. They get Promises, `AsyncIterable` streams, `AbortSignal` and the SDK's own types, never
T3's contracts, which change between releases.

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin asks for a newer T3: the server refuses to install or start a version
outside it.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags and dev paths. Settings go in `plugin-data/<id>/` and
storage in `plugins.sqlite`. They stay out of `settings.json`, whose writer drops keys it doesn't
know, and out of `statev2.sqlite`, whose numbered migrations refuse to start when a fork's id
collides with an upstream one. Settings stay out of `plugins/<id>/`, so replacing a plugin's files
keeps them. Removing a plugin deletes its settings, secrets and storage, so nothing is left that no
plugin can reach.

## Installing

Installs copy into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock, so a slow copy does not block other plugins. The
old version waits in staging until the new one starts and goes back if it fails.

Clients upload a dropped folder's files, never its path, which would mean nothing on a remote
environment. They post them over HTTP to a URL `plugins.createUploadUrl` signs for 5 minutes,
because one large WebSocket message holds up every other stream on the socket. As for attachments,
the signature is the credential, so the upload works the same on every kind of connection.

Discovery takes the id from the manifest, because people copy plugin folders in by hand. Nothing
watches `plugins/`: the server reads it at startup, on reload and when Settings asks.

## Clients

Each browser keeps its own choice of the environments it loads plugin UI from, the main one by
default, because that code runs with every connection's credentials. Right panels show only in their
environment's threads. Commands have no thread, so only the first chosen environment registers them.
Settings installs a plugin with no server code there alone.

At startup the app loads only a small stub, [`pluginUi.ts`](../../apps/web/src/plugins/pluginUi.ts).
Once the app is idle, [`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx)
follows `plugins.subscribeStates` for each chosen environment, a stream of its own because the
server config stream would resend the whole config on every plugin change. It downloads the web
loader only when an active plugin has a web part, and a separate small styles chunk only when one
has a `styles/` folder, so a client without them downloads no plugin code. The server starts plugins
after it is listening.

A bare `import(url)` cannot send credentials, so the loader fetches each bundle with the
connection's credentials and imports it from a `blob:` URL, which the desktop CSP allows. Mobile
release builds cannot load code, so the mobile app shows no plugin UI, settings or themes.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The server marks plugin themes, so the client
can show only those of chosen environments. The desktop main process cannot read localStorage, so
the page sends it the canvas it paints under a light and a dark native theme.

The loader reports a web half's failure with `plugins.reportWebFailure`, which needs the settings
write scope, so a guest or read-only client cannot put text on the plugin's row.

## Agent tools

MCP servers can't remove a tool, so each plugin tool registers with an `EnabledWhen` check that the
server runs on every list and call. A stopped plugin's tools leave new listings and answer as not
found.
