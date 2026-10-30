# Plugins

A plugin is a directory with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), an optional CommonJS server entry, and an
optional ESM web bundle, typed with [`@t3tools/plugin-sdk`](../../packages/plugin-sdk). The server
side is [`PluginHost`](../../apps/server/src/plugins/PluginHost.ts).

## Trust and failure

Plugins are code the user installed on purpose. Server entries run in the server process and web
bundles run as React code in the page, with no sandbox; manifest `permissions` are shown, not
enforced. Do not shape the API around a future sandbox. The host isolates failure instead: a plugin
that throws or hangs while loading or activating is marked failed, one that throws in a handler fails
that call, hung cleanups are abandoned after a deadline, and none of them stops the server. Enable,
disable and reload run in the host's scope, so a client that disconnects mid-change never leaves a
plugin half torn down. A newly found
plugin starts disabled; the user enables it.

## The plugin API is plain JavaScript

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams and `AbortSignal` cancellation, never Effect.

## Server entries are CommonJS

The packaged server is a Node single executable, which cannot `import()` a file from disk. A
`require` made with `module.createRequire(process.execPath)` loads files in both the executable and
plain Node, so the host uses that one path, and the manifest accepts only `.cjs` entries. Reload
drops the plugin's entries from `require.cache`; Node keeps the old module instances in memory until
the server restarts.

## State lives beside T3's

Enabled flags and dev paths go in `<stateDir>/plugins.json`, settings in
`<stateDir>/plugin-data/<id>/settings.json`, storage in `<stateDir>/plugins.sqlite`, opened on first
use. Not in `settings.json`, whose writer re-encodes its decoded struct and drops unknown keys. Not a
migration in `statev2.sqlite`, whose numbered list refuses to start when a fork migration id
collides with an upstream one. Settings stay out of `plugins/<id>/` so replacing a plugin's files
cannot lose them and a dev plugin's settings never look like an installed plugin.

## Ids and manifests

Ids are lowercase because they name directories on case-insensitive filesystems, and have no
underscores so the `plg_<id>_` prefix on plugin MCP tool names belongs to one plugin. Entry paths are
checked lexically; code that reads or serves them must still resolve symlinks. `contributes` rejects
unknown keys, so a plugin written for a newer T3 fails with a reason instead of losing one silently.
Settings are validated by Effect's JSON Schema 2020-12 importer; a schema it cannot import rejects
saves with the importer's reason.

## Clients

Plugin state reaches clients through `plugins.subscribeStates`, not the server config stream: a
settings page that opted into the shared stream would need a second subscription that resends the
whole config. Once the app is idle, a small starter follows that stream on servers that advertise
`plugins` and downloads the web loader, its own chunk, only when an active plugin has a web part.
Bare `import(url)` cannot send credentials, so the loader fetches each bundle with
the connection's bearer token or cookie and imports a `blob:` URL; the desktop CSP allows `blob:`
scripts. A T3 Connect (DPoP) connection needs the relay signer for that fetch, so it cannot load
web bundles yet. Bundles reach React and the UI kit through `globalThis.__t3PluginHost`, not an
import map. Mobile release builds cannot load code at all, so mobile renders settings from the
manifest's JSON Schema and declarative contributions only.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add an entry beside the built-ins: a `plugin` right panel kind, a
`plugin.<pluginId>.<commandId>` keybinding command, a `plugin-slash-command` composer item. The
provider slash command variant does not fit plugins, because it inserts text for the provider to
read while a plugin command runs plugin code. Where T3 has a server-supplied open variant (dynamic
tool items, themes), plugins use it. Registries are module-level `Map`s behind one version atom,
read through atoms derived from it: React Compiler would cache a plain lookup. Hot paths such as
timeline and sidebar rows re-render on that one version, never through a per-row subscription. A
plugin right panel stores its title on the surface so tab titles need no lookup, and renders
"plugin not active" with a close button while its plugin is unloaded.

## Reaching into orchestration

The orchestrator stays pure: `turns.beforeDispatch` hooks run in `ThreadManagementService.dispatch`,
before the command reaches it, with a 2-second deadline each and fail-open, and skip notifications
and guest messages. The hook registry is a `PluginHooks` reference with an inert default, so
orchestration code and its tests need no plugin wiring; the server provides one registry to the
dispatch path and the host. `events.stored` for one type lets the event sink filter before anything is
decoded for the plugin; several types share one stream so events stay in sequence order. A sliding
buffer means a slow plugin loses old events rather than stalling the server; plugins resume by
`sequence`. `turns.afterRunCompleted` is built from the same stream and the plugin's own storage:
it saves the sequence after each ended run, so runs that end while a plugin is off arrive when it
starts. Hooks skip slash commands, whose meaning an appended paragraph would change. A plugin
notification that does not start a run needs a new orchestration command, which is why the API
has none yet.

The management tools (`t3_plugins_invoke`, `t3_plugins_set_enabled`) live in `PluginMcpTools`, but
the host depends on that service, so the host hands it the two actions when it starts.

## Nothing installed costs nothing

Plugins activate after the server is listening, each in its own fiber. Clients show plugin UI only
when the environment advertises `plugins`. Plugin MCP tools are registered only while a plugin is
installed, because every agent turn pays for the advertised tool list.
