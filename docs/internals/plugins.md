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
that call, hung cleanups are abandoned after a deadline, and none of them stops the server. Node
exits on a rejection nobody handles, so every promise the API hands a plugin goes through
`forPlugin` in `facade.ts`, and only a plugin that awaits it sees the failure. Plugin code can still
fail where nothing T3 runs is waiting, such as in a timer, an async callback that awaits a failing
call or a child process with no `'error'` listener, so from the first server plugin load the host
listens for uncaught exceptions and unhandled rejections (`pluginFailureGuard.ts`). A child
process's failure has only Node's frames in its stack, so the host runs module load, `activate`,
cleanups and every plugin callback it calls in an `AsyncLocalStorage` scope naming the plugin, which
Node carries into the timers, promises and callbacks that code starts; `call` and `fork` in
`facade.ts` leave it, so T3's work for an API call is not the plugin's. The guard records a failure
raised in a plugin's scope, or else one whose error is a plugin API error or whose stack runs
through a plugin's folder, as that plugin's `serverFailure`, and passes the rest on, so T3's own
crashes still stop the server. Callbacks only T3 waits on, such as schedules, run and send hooks and
text generators, record their failures the same way. Clients get a plugin's first failure at once
and its latest at most every 5 seconds, so a timer failing in a loop does not resend the list each
time, and stopping a plugin forgets the failures of that start. Node keeps a stopped plugin's code
and timers, so the guard stays until the host stops. It holds the listeners already there, and any
added later, instead of listening beside them, because the Cursor SDK's guard exits only while it
listens alone. Enable,
disable, reload and install run in the host's scope, so a client that disconnects mid-change never
leaves a plugin half torn down. A newly found plugin starts disabled; the user enables it. The web
loader starts bundles in parallel, gives each 30 seconds to load and to activate, and undoes
anything a plugin registers after it unloads, so one stuck or slow plugin cannot hold the others.

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

Ids are lowercase because installs name directories after them on case-insensitive filesystems, and have no
underscores so the `plg_<id>_` prefix on plugin MCP tool names belongs to one plugin. Entry paths are
checked lexically; code that reads or serves them must still resolve symlinks. `contributes` rejects
unknown keys, so a plugin written for a newer T3 fails with a reason instead of losing one silently.
Settings are validated by Effect's JSON Schema 2020-12 importer; a schema it cannot import rejects
saves with the importer's reason. Saves are validated over the defaults, so a default its own field
rejects refuses every save; `t3_plugins_check` reports both before anyone saves. Plugins read top-level `default`s for fields nobody saved, while
clients get only what is saved, so a form can tell a default from a choice. A save first drops
stored keys a schema with `additionalProperties: false` no longer lists: the form cannot remove a
key it does not show, and validating it would refuse every save.

## Clients

Plugin state reaches clients through `plugins.subscribeStates`, not the server config stream: a
settings page that opted into the shared stream would need a second subscription that resends the
whole config. Once the app is idle, a small starter follows that stream on servers that advertise
`plugins` and downloads the web loader, its own chunk, only when an active plugin has a web part.
Bare `import(url)` cannot send credentials, so the loader fetches each bundle with
the connection's bearer token, cookie or, over T3 Connect, a DPoP proof signed for that one URL,
and imports a `blob:` URL; the desktop CSP allows `blob:` scripts. Bundles reach React and the UI kit through `globalThis.__t3PluginHost`, not an
import map. Mobile release builds cannot load code at all, and the mobile app shows no plugin UI,
settings or themes.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add an entry beside the built-ins: a `plugin` right panel kind, a
`plugin.<pluginId>.<commandId>` keybinding command, a `plugin-slash-command` composer item for a
web plugin's command, which runs in the page. Where T3 has a server-supplied open variant (dynamic
tool items, themes, provider slash commands), plugins use it. Registries are module-level `Map`s
behind version atoms, read through atoms derived from them: React Compiler would cache a plain
lookup. Most share one version. Actions, thread badges and `@` items each have their own, because
every timeline row, every sidebar row and the composer read them, so a change to another registry
never re-renders those rows. With no plugins no version changes, so rows never re-render because
of plugins. Chat code blocks read their own atom of code block renderers instead, so a banner or
panel change never re-renders them, and only `plg_` tool rows look up a tool renderer. A plugin
right panel stores its title on the surface so tab titles need no lookup, and renders "plugin not
active" with a close button while its plugin is unloaded.

A replaceable part (`ui.replace`) hands the plugin T3's own controls as elements T3 has already
wired, so a plugin rearranges T3's code instead of copying it and keeps working when T3 changes a
control's internals. Unused pieces are elements that never render, and `original` is the part as
T3 draws it, also drawn when a replacement throws. Replacements apply in every environment's
threads, like injected styles, and stack per part: the plugin whose id sorts first wins, as for
slash commands, so parallel loading can't change the winner; within one plugin its newest wins, and
unloading it brings back the one before. Parts have their own version atom because they sit on hot paths such as the composer
and every timeline row. A replacement that throws records the failure on its plugin's row, which
is why each registered replacement carries its plugin and environment. The `app.pageFrame` part's
`page` piece renders Settings or Usage beside the thread kept mounted under it; `index.css` hides
that thread, and the page carries `data-app-modal` so shortcut guards treat it as they treat the
window. F6 still moves between the page and the sidebar beside it.

T3 keeps the frame around a part and plugins arrange what is inside it, so updates rarely break
them. Settings and Usage draw their top row with `AppRouteHeader`, which in the page frame becomes
the window's title bar row with the window-controls inset and drag area, the same as the thread
header; plugins that restyled that row by selector broke on Windows. When a part gains a control,
put it inside an existing piece where it fits, such as `actions`, so a plugin that places that
piece gets it without an update. A new top-level piece is invisible to every plugin that replaced
the part before it existed.

The sidebar's header and footer render beside `ThreadSidebar` in `AppSidebarLayout` rather than
inside it, so the `app.sidebar` part places them without edits to the thread list. `page` leaves
Settings' section list out; the sidebar's `nav` is a second instance, loaded on demand, because the
page's own lives in the Settings route's tree and chunk. The shown page publishes its kind in an
atom, so `nav` and `page` stay null under T3's window, where the sidebar sits under the backdrop.

The composer cannot see the timeline's scroll position, which `ChatView` owns. `useTimelineFollow`
publishes the scroll-to-end pill's state per thread only while a plugin asks to fold on scroll, and
only the composer of such a plugin reads it, so threads without one never re-render on scroll. A wide screen
keeps the composer focused while the wheel scrolls, so leaving the end blurs it.

Published palettes, plugin themes among them, arrive over the server config stream after the
first paint. The client saves them in localStorage on each themes event and reads that copy until
the server sends its own, so the boot script in `index.html` and the first paint already use a
plugin theme; an empty event clears the copy. The desktop main process cannot read localStorage,
so the client sends over IPC the canvas it paints while Electron's native theme is light and while
it is dark, and the desktop keeps both in its settings for the next window and the WSL splash. The
pair is keyed by the native theme rather than by the theme's halves because a launch starts from
the system appearance before the page pins one, so a theme pinned to dark sends its dark canvas
for both.

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
to the main process as one list that replaces the previous one. The main process outlives the
page, so a new page holds its list back until its first round of plugin loads ends, then sends it
even when it is empty; a page with no web plugins sends an empty list once. A reload keeps the tray
icon and shortcuts in between, and an unloaded plugin never leaves stale items. Clicks and
shortcuts come back through the existing menu-action channel as the `plugin.<pluginId>.<commandId>`
command.

## Reaching into orchestration

The orchestrator stays pure: `turns.beforeDispatch` hooks run in `ThreadManagementService.dispatch`,
before the command reaches it, with a 2-second deadline each and fail-open, and skip notifications
and guest messages. The logic lives in `pluginSendHooks.ts` behind one call, because that file is
one of upstream's busiest. While any hook or plugin command is registered, a thread's messages and
queued edits pass hooks and dispatch one at a time in arrival order, or a 10-second command would
let the message sent after it reach the agent first. A message still in line keeps the next one
behind it after the last hook or command is removed. Other threads never wait, and a plugin's own
sends skip the line, so a command handler that sends to its thread cannot wait on itself. Queued edits and delegated task prompts reach agents without a new
message, so they run the hooks there too, or a redaction plugin could be bypassed by editing a
queued message. A message whose id is already recorded passed the hooks when it was first sent: a
steer that misses its turn sends it again under a new command id, and hooks would apply twice. A
block fails the dispatch with `OrchestratorCommandRejectedError` caused by
the plugin's reason: every caller already handles that error and releases claimed attachments, and
clients show the deepest error message, so the sender sees the reason and keeps the draft. The hook registry is a `PluginHooks` reference with an inert default, so
orchestration code and its tests need no plugin wiring; the server provides one registry to the
dispatch path and the host. `events.stored` for one type lets the event sink filter before anything is
decoded for the plugin; several types share one stream so events stay in sequence order. Events
stored before the call are read from the database page by page as the plugin asks, so resuming
from an old `sequence` gets every one; after that a sliding buffer means a slow plugin loses old
events rather than stalling the server. `turns.afterRunCompleted` reads the same events through a stream that waits instead of
dropping, because a dropped run would be lost for good once the saved position moves past it. It
saves the sequence in the plugin's storage, under the `t3.` prefix that the plugin's own `list`
skips and its writes refuse, when the plugin first subscribes and after each run,
with the last 256 ended runs: runs that end while a plugin is off arrive when it starts, even
before it has handled one, and a run updated again after it ended (a checkpoint landing on an
interrupted run) is not delivered twice, while a retry, which sets the failed run back to
`preparing`, makes it deliverable again, and a revert delivers a run once more as `rolled_back`. Command replies are recorded with `run.created` alone, so
one arrives only when a revert rolls it back. A slash command, a name in T3's, the provider's or a plugin's list, skips the hooks,
because changed text would change what the command does and a block would keep T3, the agent or a
plugin from doing its job; other text that starts with `/`, such as a path, gets every hook. A
queued edit reads its run's provider; a delegated task that names no model is checked without one,
so any `/name` there skips them. Hooks see the message's `creationSource`, because text the
server writes, such as the usage-limit resume, is sent as the user.

`turns.onRuntimeRequest` reacts to stored events too and answers through the same
`runtime-request.respond` command a client sends, so every adapter that raises approvals or
questions (Claude, Codex, ACP agents such as Grok and Antigravity, OpenCode, Pi) is covered, and
Cursor raises none. Adapters record a request and its turn item in either order, so the reactor
watches both event types and asks plugins once both exist. Requests that cannot be answered
(`not_resumable`) are skipped, and plugins choose only from the decisions the request offers,
because adapters map the rest differently (`acceptAlways` is a deny in Claude). The user sees the
request while plugins decide: holding it back would need a change at every adapter. The reactor
follows events only while a hook is registered, so when it starts, such as after the only hooked
plugin reloads, it also reads the pending requests of threads that may be live.

A server plugin's slash commands are provider slash commands: the server adds them to every
provider's lists where it adds `/usage-limits`, so every client lists them with no plugin code, and
the `beforeDispatch` path runs the plugin's handler without the send hooks. A provider's own command
of the same name wins in that provider's lists and when a message goes to it, so a plugin cannot
take `/review` from an agent that has one. That includes the commands of the thread's folder
(its worktree, else its project root), which the composer lists from the provider's workspace
snapshot. T3's own names, shared with the composer, are refused at registration. Two plugins may
register one name: the one whose id sorts first handles it, so start order never picks the
winner, and the other keeps the rest of its commands. A handler's `reply` turns
the message into the internal `thread.command-reply.record` command under the message's command id,
so a retry replays it. The orchestrator records the sent message and an `assistant_message` reply
as a run that is already completed, with no provider thread, attempt or checkpoint: clients drop a
sent message once a user message with its id exists, and paged clients drop run-less items. A
reply takes the next ordinal even while a turn runs, so the thread shell leaves reply runs out
like idle compactions (`isSilentRunForShell` and its SQL twin), and `latestExecutedRun` and its
SQL twins skip them; otherwise a reply sent mid-turn would become the thread's status and hide
the turn's failure. For the same reason `ThreadManagementService.latestRun` passes over a reply
while a turn runs, so waiting on the thread waits for the turn. A reply carries the instance of the
thread's active provider thread rather than the message's model selection: the queued-run start
takes the latest finished run as the handoff source, and a reply filed under a provider the user
just picked would skip the context handoff its first turn needs. Web takes a message's revert target from
the previous run's checkpoint, so the first message after a reply has no revert button, while the
command itself still reverts to before it. When a new
thread's first message gets a reply, `ThreadLaunchService` prepares the workspace as for a launch
without a message.

Text generation hooks wrap the `TextGeneration` router, which every caller goes through, so thread
titles, commit messages, pull request content, branch names and review guides all ask plugins
first, and plugin answers get the cleanup T3 gives model output. `textGeneration.generate` runs a
plugin's own prompt on the settings' text generation model through the router's `generateText`.
Drivers built with `fromRunner` get it from their JSON runner, with the answer in one `text` field;
it is optional on `ProviderTextGeneration`, so drivers that cannot run a prompt (Fx, the ACP
Registry driver, plugin ACP agents and Muse) need no change and the router fails with
`TextGenerationUnsupportedError`. It is optional on the router service too, so test fakes of the
router need not stub it. Drivers that pick a runtime per call, such as OpenCode's 1.x
and 2 servers, must forward it, or the router sees it missing. Like the tasks,
it moves to the fallback model when the selected one's usage limit is reached, skipping providers
without `generateText`.

Plugin instructions and skill folders ride on each adapter turn input, read once per turn in
`RunExecutionService`, so adapters never look up plugins. Claude appends the instructions to T3's
system prompt text, before the user's own launch text. Claude loads a plugin folder whole
(`--plugin-dir`), commands, agents, hooks and MCP servers included, so it gets a folder the host
generates under `<stateDir>/plugin-agents/<id>` with only a manifest and a copy of `skills/`,
written when the plugin starts and removed when it stops. Codex
gets the instructions as `application` context entries and the `skills` folders through
`skills/extraRoots/set`, sent only when they change. The ACP agents (Grok, Antigravity, Fx),
OpenCode, Cursor, Pi and Muse are not wired: each puts T3's own text in its own place, so each
needs its own change, and none takes a skill folder from T3. Claude reads them only when its
process starts, so they are part of the adapter's process reuse key: turning a plugin on or off, or
changing its instructions, starts a new process at the thread's next turn. A reload that only
edits skill files keeps the same folder, so those reach a thread when its process next restarts. The `$` picker reads
each provider's skill list, so the host reads the skills' frontmatter when plugin states change and
the server adds them to the Claude and Codex lists where it adds plugin slash commands, under the
name each invokes: Claude namespaces a `--plugin-dir` folder's skills by its manifest name, and the
adapter's skill dispatch reads the turn's plugin folders so `$<id>:<skill>` becomes `/<id>:<skill>`.

`threads.notify` and slash command replies are the plugin changes inside `Orchestrator.ts`, each
one internal command, because every `message.dispatch` starts a run. A note
(`thread.notification.record`) joins the thread's latest finished run. `TurnItemPositionStore`
sorts run-less items before every run, and clients drop them from paged threads, while a note inside
a running turn would split its live output.

`secrets.request` shows the card the `request_secret` MCP tool uses, through
`SecretRequests.request`, which both call. The card belongs to a run and the answer is refused once
that run ends, so it needs a turn in progress. It resolves with the value and takes it out of the
secret store, as `settings.get()` hands plugins their `t3-secret` values: plugins are trusted code
in the server, so a one-use ref would only add a step. A plugin tool's handler gets the calling
thread's id, so a tool can ask in the thread whose turn is waiting on it.

MCP has no tool removal, so a deactivated plugin's tools stay listed and answer that the plugin is
disabled, and turning it back on swaps the handlers in place. A call still running when the plugin
turns off ends with that answer, like `invoke`, even if its handler ignores the abort signal. Claude reads the tool list once per
session (checked with Haiku 5.5): a plugin turned on mid-thread gives its tools to threads started
after that, not to the running session.

The `t3_plugins_*` management tools live in `PluginMcpTools`, but the host depends on that service,
so the host hands it its actions when it starts.

A web half fails in the browser, where agents cannot see it, so the web loader reports the failure
with `plugins.reportWebFailure` and the host adds it to the plugin's state, which the tools return.
The host keeps it in memory for the start whose `revision` the report names, so a restart clears it
and a late report about an earlier start is ignored. The call needs the settings write scope:
agents read the text, so a guest or read-only client must not write it.

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
whose rebuild still fails removes its driver so the kind stays free. Adding a driver builds its
instances without their secrets, as startup does: one that needs a secret shows "Reading secrets…"
until a read outside the lock finishes, so a vault prompt never holds other registry changes. The
registry also holds its lock while `create` runs, so the host fails each instance's `create` after
20 seconds. `registerDriver` builds the kind's saved instances one after another, so an `activate`
that awaits it outlasts its 30 seconds, and the plugin fails, once 2 of them hang.

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
ACP agent's snapshot is therefore "ready" with unknown sign-in until a turn runs. It writes no
text for T3 and says so with `supportsTextGeneration: false`, which keeps it out of the text
generation pickers and the usage-limit fallback: the router switches providers only on a usage
limit, so a selected provider that cannot write fails every title and commit message.

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
a symlinked plugin is the author's own folder. Git clones and update checks run with T3's
background git environment, which turns off every credential prompt, and `GIT_ALLOW_PROTOCOL` set,
which blocks transports such as `ext::` that run commands.

An agent writing a plugin installs its folder with `link`, which adds it to `devPaths` rather than
copying it, so edits plus a reload are the whole loop; removing it only takes it out of
`devPaths`. Symlinks into `plugins/` would do the same but need extra rights on Windows. A folder
inside `plugins/` cannot be linked: discovery lists it as installed and that copy wins, so removing
the plugin would delete the folder. A link shadowed by another copy with its id never starts, and
Settings removes it by its folder, which leaves the copy in use alone. Settings never take a typed
folder path; linking is for agents through MCP. `t3_plugins_check` reads a
plugin's files and never loads its code, so it can check a folder before anyone trusts it. A
`path` needs write access, because it can name any folder on the server.

Discovery takes a plugin's id from its manifest, not its folder name, because people copy plugin
folders in by hand. A folder named after its id wins over other copies, and installs replace a
plugin in the folder it was found in. There is no watcher on `plugins/`: the server reads it at
startup, on reload and when Settings → Plugins asks with `plugins.rescan`, so an idle server pays
nothing for it. A rescan that changes nothing publishes nothing, so each visit to Settings does not
resend the list to every client and make provider streams rebuild their skill lists.

`plugins.installFiles` takes a folder the client read from a drop or a folder picker, in one
message, within the limits in the contract. Clients cannot hand the server a path, which would
mean nothing on a remote environment. Sent files record no source, so they may replace only a
plugin that has none, and a git or npm plugin cannot be taken over by dropping a folder with its id.
Settings installs on several environments main first: plugin UI loads only from the main
environment, so a plugin without server code or agent skills goes nowhere else.

Install records the npm version or git commit it fetched in `plugins.json`. Update checks compare
it with the registry's tag or `git ls-remote` and keep what they found there with the time of the
check, so a restart before the next check is due starts no network request.

## Nothing installed costs nothing

Plugins activate after the server is listening, each in its own fiber. Clients show plugin UI only
when the environment advertises `plugins`. Plugin MCP tools are registered only when a plugin adds
them, and the `t3_plugins_*` management tools follow the Settings switch (`agentTools` in
`plugins.json`), which is off until the user turns it on, because every agent turn pays for the
advertised tool list. MCP has no tool removal, so a session that listed a tool keeps it,
and a withdrawn one refuses every call.
