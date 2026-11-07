# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process and
web bundles run as React code in the page, with no sandbox. Manifest `permissions` are shown on the
plugin's row and not enforced, and `settings.get()` and `secrets.request` hand plugins secret
values in plain text. Do not shape the API around a future sandbox.

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
instances. They get Promises, `AsyncIterable` streams and `AbortSignal`. Source control hosts are
the one exception (below).

Manifests ignore keys they don't know, so a newer manifest key is lost silently on an older T3.
`engines.t3` is how a plugin asks for a newer T3: the server refuses to install, update to or start
a version outside it.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags, dev paths, install sources, update check results and
the version each plugin can roll back to. Settings go in `plugin-data/<id>/`, storage in
`plugins.sqlite` and the version an update replaced in `plugin-rollback/<id>`. They stay out of
`settings.json`, whose writer drops keys it doesn't know, and out of `statev2.sqlite`, whose
numbered migrations refuse to start when a fork's id collides with an upstream one. Settings stay
out of `plugins/<id>/`, so replacing a plugin's files keeps them.

## Installing

Installs fetch into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock, so a slow clone does not block other plugins. The
old version waits in staging until the new one starts, goes back if it fails, and otherwise moves
to `plugin-rollback/<id>`. Git may use only https, ssh and file: plain http and git let the network
change the code, and others such as `ext::` run commands. Update checks download a newer version to
read its `engines.t3`, so they offer only versions this server runs.

An agent writing a plugin installs its folder with `link`, which adds it to `devPaths`. Symlinks
into `plugins/` would do the same but need extra rights on Windows. Clients send the files of a
dropped folder, never its path, which would mean nothing on a remote environment. Sent files record
no source, so dropping a folder cannot take over a git or npm plugin. Discovery takes the id from
the manifest, because people copy plugin folders in by hand. Nothing watches `plugins/`: the server
reads it at startup, on reload and when Settings asks.

## Clients

Plugin state has its own stream, `plugins.subscribeStates`, because the server config stream would
resend the whole config on every plugin change.

Plugin UI loads from the main environment. With none, as on app.t3.codes or a desktop with its local
environment off, it loads from the one picked under "Load plugin UI from", which starts as none and
is kept in that browser. Settings installs a plugin with no server code or agent skills on that
environment alone.

At startup the app loads only a small stub, [`pluginUi.ts`](../../apps/web/src/plugins/pluginUi.ts).
Once the app is idle,
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx) follows the state
stream. It downloads the web loader only when an active plugin has a web part, and a separate small
styles chunk only when one has a `styles/` folder. Until then, rows read nothing from plugins. The
startup chunk holds about 4.8 KB of minified plugin code, and plugin support adds about 36 KB raw
(12.3 KB gzip) at startup, mostly plugin RPC schemas and the theme cache. With no plugins, a client
opens 1 subscription on its WebSocket and gets a snapshot of about 60 B. The server starts plugins
after it is listening, and one with no plugin from git or npm never checks for updates.

A bare `import(url)` cannot send credentials, so the loader fetches each bundle with the
connection's credentials and imports it from a `blob:` URL, which the desktop CSP allows. Mobile
release builds cannot load code, so the mobile app shows no plugin UI, settings or themes.

`ui.replace` hands a plugin T3's own controls as elements T3 has already wired, so a plugin
rearranges them instead of copying them. When a part gains a control, put it inside an existing
piece where it fits, such as `actions`, so plugins that place that piece get it without an update.
A new top-level piece is invisible to every plugin that replaced the part before it existed.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The desktop main process cannot read
localStorage, so the page sends it the canvas it paints under a light and a dark native theme.

Thread menus are built and dispatched in two places, the header hook and the sidebar. Both hand
`plugin:` ids to `runPluginThreadMenuItem` before their own `switch`, and a new menu must too.

## Reaching into orchestration

The orchestrator stays pure. Send hooks run in `ThreadManagementService.dispatch` before the
command reaches it, behind one call into
[`pluginSendHooks.ts`](../../apps/server/src/plugins/pluginSendHooks.ts), because that service is
one of upstream's busiest files. All of a message's hooks share a 2-second budget, and a hook that
starts late still gets 100ms. Hooks run as soon as a message arrives. While any hook or plugin
command is registered, only the dispatch waits for the thread's previous message, so messages keep
their order and slow hooks never add up. Queued edits and delegated task prompts run the hooks
too, or editing a queued message would bypass a redaction plugin.

`turns.onRuntimeRequest` answers through the same `runtime-request.respond` command a client sends,
so it covers every adapter. Plugins choose only from the decisions a request offers, because
adapters map the rest differently: Claude treats `acceptAlways` as a deny. The user sees the request
while plugins decide, because holding it back would need a change in every adapter.

Server plugins' slash commands are provider slash commands, added where the server adds
`/usage-limits`, so every client lists them with no plugin code. `threads.notify` is its own
internal command in `Orchestrator.ts`, because every `message.dispatch` starts a run.

Text generation hooks wrap the `TextGeneration` router, which every caller goes through. Each plugin
gets 3 seconds and all of them share 5 per text, then T3 generates the text itself. Drivers that
pick a runtime per call, such as OpenCode's, must forward the optional `generateText`, or
`textGeneration.generate` sees it missing.

Instructions and skill folders ride on each adapter turn input, so adapters never look up plugins.
Claude loads a `--plugin-dir` folder whole, hooks and MCP servers included, so the host generates
`<stateDir>/plugin-agents/<id>` with only a manifest and `skills/`. Claude reads it only when its
process starts, so it is part of the adapter's process reuse key. Codex gets skills through
`skills/extraRoots/set`. Other adapters each need their own change.

MCP has no tool removal, so a stopped plugin's tools stay listed and answer that the plugin is
disabled. The `t3_plugins_*` tools start off, because every agent turn pays for the advertised tool
list. The loader reports a web half's failure with `plugins.reportWebFailure`, which needs the
settings write scope because agents read the text.

## ACP agents and source control hosts

`registerAcpAgent` builds a driver from plain data on the shared ACP adapter, like `fx`, not on the
ACP Registry driver, whose instances carry the registry's kind and whose status check opens a
session. So an ACP agent shows "ready" with unknown sign-in until a turn runs. It sets
`supportsTextGeneration: false` to stay out of the text generation pickers: the router switches
providers only on a usage limit, so a selected provider that can't write text fails every title.

Source control drivers are Effect code in the server's runtime. A plugin's own `effect` would work
only while it matched the server's, so drivers build with `api.providers.runtime`. The SDK's source
control types are T3's own, and those change with every nightly, so such a plugin tracks one T3
version. A plugin host joins remote recognition after the built-ins, so it cannot take a built-in
host's remotes.
