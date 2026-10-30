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
whole config. Desktop and hosted web authenticate `/api` with bearer tokens, which a bare
`import(url)` cannot send, so web bundles are fetched with the authenticated fetch and imported from
a `blob:` URL; the desktop CSP allows `blob:` scripts. Bundles reach React and the UI kit through
`globalThis.__t3PluginHost`, not an import map. Mobile release builds cannot load code at all, so
mobile renders settings from the manifest's JSON Schema and declarative contributions only.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add to a registry that built-ins register into first. Where T3
already has a server-supplied open variant (provider slash commands, dynamic tool items, themes),
plugins use it. Hot paths such as timeline and sidebar rows read a module-level `Map` and re-render
on one list-level version, never a per-row subscription.

## Reaching into orchestration

The orchestrator stays pure: `turns.beforeDispatch` hooks run in `ThreadManagementService.dispatch`,
before the command reaches it, with a 2-second deadline each and fail-open, and skip notifications
and guest messages. The hook registry is a `PluginHooks` reference with an inert default, so
orchestration code and its tests need no plugin wiring; the server provides one registry to the
dispatch path and the host. `events.stored` opens one stored-event stream per requested type, so the
event sink filters before anything is decoded for the plugin, behind a sliding buffer that a slow
plugin overflows rather than stalls; plugins resume by `sequence`. A plugin notification that does
not start a run needs a new orchestration command, which is why the API has none yet.

## Nothing installed costs nothing

Plugins activate after the server is listening, each in its own fiber. Clients show plugin UI only
when the environment advertises `plugins`. Plugin MCP tools are registered only while a plugin is
installed, because every agent turn pays for the advertised tool list.
