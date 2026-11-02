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
disable, reload and install run in the host's scope, so a client that disconnects mid-change never
leaves a plugin half torn down. A newly found plugin starts disabled; the user enables it. The web
loader starts bundles in parallel, gives each 30 seconds to load and to activate, and undoes
anything a plugin registers after it unloads, so one stuck or slow plugin cannot hold the others.

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

Enabled flags, dev paths and install sources go in `<stateDir>/plugins.json`, settings in
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
the connection's bearer token, cookie or, over T3 Connect, a DPoP proof signed for that one URL,
and imports a `blob:` URL; the desktop CSP allows `blob:` scripts. Bundles reach React and the UI kit through `globalThis.__t3PluginHost`, not an
import map. Mobile release builds cannot load code at all, so mobile renders settings from the
manifest's JSON Schema and declarative contributions only.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add an entry beside the built-ins: a `plugin` right panel kind, a
`plugin.<pluginId>.<commandId>` keybinding command, a `plugin-slash-command` composer item. The
provider slash command variant does not fit plugins, because it inserts text for the provider to
read while a plugin command runs plugin code. Where T3 has a server-supplied open variant (dynamic
tool items, themes), plugins use it. Registries are module-level `Map`s behind one version atom,
read through atoms derived from it: React Compiler would cache a plain lookup. Rows in hot paths,
such as timeline and sidebar rows, each read that one shared version; with no plugins it never
changes, so rows never re-render because of plugins.
Chat code blocks read their own atom of code block renderers instead, so a banner or panel change
never re-renders them, and only `plg_` tool rows look up a tool renderer. A
plugin right panel stores its title on the surface so tab titles need no lookup, and renders
"plugin not active" with a close button while its plugin is unloaded.

A replaceable part (`ui.replace`) hands the plugin T3's own controls as elements T3 has already
wired, so a plugin rearranges T3's code instead of copying it and keeps working when T3 changes a
control's internals. Unused pieces are elements that never render, and `original` is the part as
T3 draws it, also drawn when a replacement throws. Replacements apply in every environment's
threads, like injected styles, and stack per part: the newest wins, and unloading it brings back the
one before. Parts have their own version atom because they sit on hot paths such as the composer
and every timeline row. The `app.pageFrame` part's `page` piece renders Settings or Usage beside
the thread kept mounted under it; `index.css` hides that thread, and the page carries
`data-app-modal` so focus and shortcut guards treat it as they treat the window.

The sidebar's header and footer render beside `ThreadSidebar` in `AppSidebarLayout` rather than
inside it, so the `app.sidebar` part places them without edits to the thread list. `page` leaves
Settings' section list out; the sidebar's `nav` is a second instance, loaded on demand, because the
page's own lives in the Settings route's tree and chunk. The shown page publishes its label in an
atom, so `nav` and `page` stay null under T3's window, where the sidebar sits under the backdrop.

The composer cannot see the timeline's scroll position, which `ChatView` owns. `useTimelineFollow`
publishes the scroll-to-end pill's state per thread, and the composer reads it only while a plugin
asks to fold on scroll, so a composer without plugins never re-renders on scroll. A wide screen
keeps the composer focused while the wheel scrolls, so leaving the end blurs it.

Published palettes, plugin themes among them, arrive over the server config stream after the
first paint. The client saves them in localStorage on each themes event and reads that copy until
the server sends its own, so the boot script in `index.html` and the first paint already use a
plugin theme; an empty event clears the copy. The desktop main process cannot read localStorage,
so the client sends the applied palette's canvas over IPC and the desktop keeps it in its settings
for the next window.

Plugin buttons, menu items and badges belong to the plugin's environment, since they act through
its server half. Thread menus are built and dispatched in two places (the header hook and the
sidebar); plugin items carry `plugin:` ids that both pass to `runPluginThreadMenuItem` before
their own `switch`. A badge change replaces only the changed thread's array, so other sidebar rows
keep the same value and do not re-render. A plugin `@` item becomes a chip of kind `plugin`, a
context kind T3 does not know, which the server already hands to agents as its JSON payload. The
draft holds only the chip's reference; the send path looks the item up and attaches its record,
so drafts, their persistence and queued edits need no plugin slot, and a chip whose plugin is off
is sent as unavailable.

In the desktop app, plugin commands that ask for a menu item, a tray item or a global shortcut cross
to the main process as one list that replaces the previous one, so a reload or an unloaded plugin never leaves
stale items. Clicks and shortcuts come back through the existing menu-action channel as the
`plugin.<pluginId>.<commandId>` command.

## Reaching into orchestration

The orchestrator stays pure: `turns.beforeDispatch` hooks run in `ThreadManagementService.dispatch`,
before the command reaches it, with a 2-second deadline each and fail-open, and skip notifications
and guest messages. The hook registry is a `PluginHooks` reference with an inert default, so
orchestration code and its tests need no plugin wiring; the server provides one registry to the
dispatch path and the host. `events.stored` for one type lets the event sink filter before anything is
decoded for the plugin; several types share one stream so events stay in sequence order. A sliding
buffer means a slow plugin loses old events rather than stalling the server; plugins resume by
`sequence`. `turns.afterRunCompleted` reads the same events through a stream that waits instead of
dropping, because a dropped run would be lost for good once the saved position moves past it. It
saves the sequence and the last 256 ended runs in the plugin's storage: runs that end while a
plugin is off arrive when it starts, and a run updated again after it ended (a checkpoint landing
on an interrupted run) is not delivered twice. Hooks skip slash commands, whose meaning an
appended paragraph would change.

`threads.notify` is the one plugin change inside `Orchestrator.ts`: the internal
`thread.notification.record` command, because every `message.dispatch` starts a run. The note joins
the thread's latest finished run. `TurnItemPositionStore` sorts run-less items before every run, and
clients drop them from paged threads, while a note inside a running turn would split its live output.

The `t3_plugins_*` management tools live in `PluginMcpTools`, but the host depends on that service,
so the host hands it its actions when it starts.

## Installing

`plugins.install` fetches into `<stateDir>/plugin-staging/<uuid>`, outside `plugins/`, so discovery
never sees a half-written plugin. Only the swap (old version aside, new version in, by rename) takes
the lifecycle lock, so a slow clone does not block other plugins. A crash between the 2 renames
leaves the old version in staging; startup puts it back when nothing replaced it, then clears
staging. Uninstall deletes the entry in `plugins/`, never the plugin's resolved `rootDir`, which for
a symlinked plugin is the author's own folder. Git clones run with prompts off and
`GIT_ALLOW_PROTOCOL` set, which blocks transports such as `ext::` that run commands.

## Nothing installed costs nothing

Plugins activate after the server is listening, each in its own fiber. Clients show plugin UI only
when the environment advertises `plugins`. Plugin MCP tools are registered only while a plugin is
installed, because every agent turn pays for the advertised tool list.
