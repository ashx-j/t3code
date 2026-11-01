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
loader gives each bundle 30 seconds to load and to activate, and undoes anything a plugin registers
after it unloads, so one stuck or slow plugin cannot hold the others.

## The plugin API is plain JavaScript

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams and `AbortSignal` cancellation, never Effect,
except for provider drivers (below).

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
the connection's bearer token or cookie and imports a `blob:` URL; the desktop CSP allows `blob:`
scripts. A T3 Connect (DPoP) connection needs the relay signer for that fetch, so it cannot load
web bundles yet. Bundles reach React and the UI kit through `globalThis.__t3PluginHost`, not an
import map. Mobile release builds cannot load code at all, so mobile renders settings from the
manifest's JSON Schema and declarative contributions only.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add an entry beside the built-ins: a `plugin` right panel kind, a
`plugin.<pluginId>.<commandId>` keybinding command, a `plugin-slash-command` composer item for a
web plugin's command, which runs in the page. Where T3 has a server-supplied open variant (dynamic
tool items, themes, provider slash commands), plugins use it. Registries are module-level `Map`s behind one version atom,
read through atoms derived from it: React Compiler would cache a plain lookup. Hot paths such as
timeline and sidebar rows re-render on that one version, never through a per-row subscription.
Chat code blocks read their own atom of code block renderers instead, so a banner or panel change
never re-renders them, and only `plg_` tool rows look up a tool renderer. A
plugin right panel stores its title on the surface so tab titles need no lookup, and renders
"plugin not active" with a close button while its plugin is unloaded.

In the desktop app, plugin commands that ask for a menu item or a global shortcut cross to the main
process as one list that replaces the previous one, so a reload or an unloaded plugin never leaves
stale items. Clicks and shortcuts come back through the existing menu-action channel as the
`plugin.<pluginId>.<commandId>` command.

## Reaching into orchestration

The orchestrator stays pure: `turns.beforeDispatch` hooks run in `ThreadManagementService.dispatch`,
before the command reaches it, with a 2-second deadline each and fail-open, and skip notifications
and guest messages. A block fails the dispatch with `OrchestratorCommandRejectedError` caused by
the plugin's reason: every caller already handles that error and releases claimed attachments, and
clients show the deepest error message, so the sender sees the reason and keeps the draft. The hook registry is a `PluginHooks` reference with an inert default, so
orchestration code and its tests need no plugin wiring; the server provides one registry to the
dispatch path and the host. `events.stored` for one type lets the event sink filter before anything is
decoded for the plugin; several types share one stream so events stay in sequence order. A sliding
buffer means a slow plugin loses old events rather than stalling the server; plugins resume by
`sequence`. `turns.afterRunCompleted` reads the same events through a stream that waits instead of
dropping, because a dropped run would be lost for good once the saved position moves past it. It
saves the sequence and the last 256 ended runs in the plugin's storage: runs that end while a
plugin is off arrive when it starts, and a run updated again after it ended (a checkpoint landing
on an interrupted run) is not delivered twice. Hooks skip slash commands, whose meaning changed
text would change.

`turns.onRuntimeRequest` reacts to stored events too and answers through the same
`runtime-request.respond` command a client sends, so every adapter that raises approvals or
questions (Claude, Codex, ACP agents such as Grok and Antigravity, OpenCode, Pi) is covered, and
Cursor raises none. Adapters record a request and its turn item in either order, so the reactor
watches both event types and asks plugins once both exist. Requests that cannot be answered
(`not_resumable`) are skipped, and plugins choose only from the decisions the request offers,
because adapters map the rest differently (`acceptAlways` is a deny in Claude). The user sees the
request while plugins decide: holding it back would need a change at every adapter.

A server plugin's slash commands are provider slash commands: the server adds them to every
provider's lists where it adds `/usage-limits`, so every client lists them with no plugin code, and
the `beforeDispatch` path runs the plugin's handler instead of the hooks. A command ends in a sent
or a blocked message and cannot answer on its own: clients keep a sent message on screen until
the server records a user message with its id, and recording one without starting a run would need
a new orchestrator command.

Text generation hooks wrap the `TextGeneration` router, which every caller goes through, so thread
titles, commit messages, pull request content, branch names and review guides all ask plugins
first, and plugin answers get the cleanup T3 gives model output. There is still no free-form
`text.generate`: providers only offer these tasks, and adding one means a new method in every
text generation driver.

Plugin instructions and skill folders ride on each adapter turn input, read once per turn in
`RunExecutionService`, so adapters never look up plugins. Claude appends the instructions to T3's
system prompt text, before the user's own launch text. Claude loads a plugin folder whole
(`--plugin-dir`), commands, agents, hooks and MCP servers included, so it gets a folder the host
generates under `<stateDir>/plugin-agents/<id>` with only a manifest and a copy of `skills/`,
written when the plugin starts and removed when it stops. Codex
gets the instructions as `application` context entries and the `skills` folders through
`skills/extraRoots/set`, sent only when they change. The ACP agents (Grok, Antigravity, Fx),
OpenCode, Cursor, Pi and Muse are not wired: each puts T3's own text in its own place, so each
needs its own change, and none takes a skill folder from T3. Claude starts a process with its
options, so a change reaches a Claude thread when its next process starts. The composer's `$`
picker lists what each provider discovers, which does not include plugin skills yet.

`threads.notify` is the one plugin change inside `Orchestrator.ts`: the internal
`thread.notification.record` command, because every `message.dispatch` starts a run. The note joins
the thread's latest finished run. `TurnItemPositionStore` sorts run-less items before every run, and
clients drop them from paged threads, while a note inside a running turn would split its live output.

The `t3_plugins_*` management tools live in `PluginMcpTools`, but the host depends on that service,
so the host hands it its actions when it starts.

## Provider drivers

Provider drivers are Effect code that the server runs inside its own runtime, so this is the one
place plugins use Effect. The server bundles its own copy of `effect`, and a copy a plugin
imports would only work while both are the same version. A driver is built with the modules in
`api.providers.runtime` instead, and its types come from `@t3tools/plugin-sdk/server/providers`,
which re-exports T3's provider packages. Those change with every nightly, so a provider plugin
tracks one T3 version.

The instance registry keeps its drivers in a `Ref` seeded with the built-ins, read only by
reconcile and secret reloads, never per turn. Adding a driver rebuilds instances saved for its
kind, which stay as unavailable entries while no driver exists, and gives it a default instance
the way built-ins get one. That default starts off, because clients treat every unsaved default
but Codex's and Claude's as off; the settings page lists it from the snapshot. Removing a driver
leaves its saved instances unavailable. Adding or removing one rebuilds only its kind, so other
unavailable instances do not wait on a secret read again. Built-in kinds cannot be replaced.
Registration is a hydration service rather than a mutator method because only there is the
drivers' service type concrete, so plugin drivers get the services built-ins get. A defect stops
the reconcile that rebuilds every instance, so the registry catches defects while decoding a
config, the host turns defects in a plugin's `create` into driver errors, and a registration
whose rebuild still fails removes its driver so the kind stays free.

Clients pick a provider's card, icon and form from static definitions, so a plugin's driver
declares `client.settingsSchema` (the JSON Schema subset plugin settings use) and
`client.iconUrl`. They travel in the driver's metadata, so its unavailable instances keep the
form and a config that fails to decode can be fixed, and the host stamps them onto live
snapshots. Web draws the plugin settings form from the schema where it has no definition for the
driver. The form saves into the instance's config, which every client receives, so the host
refuses `t3-secret` fields. An Effect `configSchema` is not
converted, because its JSON Schema uses `anyOf` for optional fields, which that form cannot draw.
Mobile has no provider settings form for any driver.

`registerAcpAgent` builds a whole driver from plain data, so most agent plugins need no Effect
code. It uses the shared ACP adapter with the base ACP capabilities, like the `fx` driver, not
the ACP Registry driver: that driver's instances carry its own kind, so clients would show the
registry's card, and its status check opens a session, which background checks must not do. An
ACP agent's snapshot is therefore "ready" with unknown sign-in until a turn runs, and it writes
no text for T3 (titles and commit messages fall back to other providers).

## Source control hosts

Source control drivers are built once in a layer, and remote recognition reads a definitions
registry that clients share. A plugin's host goes into a plugin driver list beside the built-in
one, which the provider and pull request registries read after their own map, and its definition
is registered into the shared registry after the built-ins, so a plugin cannot take a built-in
host's remotes. The driver runs in its own scope with the host services and rate limit built-ins
share, and leaves both when the plugin turns off. Discovery items already carry the spec's label,
so the settings page names a plugin host without a client definition; elsewhere clients show the
generic host presentation. Plugin hosts get no app sign-in, media proxy or repository identity
refinement, which read the built-in list.

## Installing

`plugins.install` fetches into `<stateDir>/plugin-staging/<uuid>`, outside `plugins/`, so discovery
never sees a half-written plugin. Only the swap (old version aside, new version in, by rename) takes
the lifecycle lock, so a slow clone does not block other plugins. A crash between the 2 renames
leaves the old version in staging; startup puts it back when nothing replaced it, then clears
staging. Uninstall deletes the entry in `plugins/`, never the plugin's resolved `rootDir`, which for
a symlinked plugin is the author's own folder. Git clones run with prompts off and
`GIT_ALLOW_PROTOCOL` set, which blocks transports such as `ext::` that run commands.

Install records the npm version or git commit it fetched in `plugins.json`. Update checks compare
it with the registry's tag or `git ls-remote` and keep what they found there with the time of the
check, so a restart before the next check is due starts no network request.

## Nothing installed costs nothing

Plugins activate after the server is listening, each in its own fiber. Clients show plugin UI only
when the environment advertises `plugins`. Plugin MCP tools are registered only while a plugin is
installed, because every agent turn pays for the advertised tool list.
