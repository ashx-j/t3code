# Plugins

A plugin is a directory with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), an optional CommonJS server entry, and an
optional ESM web bundle, typed with [`@t3tools/plugin-sdk`](../../packages/plugin-sdk).

## Trust and failure

Plugins are code the user installed on purpose. Server entries run in the server process and web
bundles run as React code in the page, with no sandbox; manifest `permissions` are shown, not
enforced. Do not shape the API around a future sandbox. The host isolates failure instead: a plugin
that throws while loading or activating is marked failed, one that throws in a handler fails that
call, and neither stops the server.

## The plugin API is plain JavaScript

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams and `AbortSignal` cancellation, never Effect.

## Server entries are CommonJS

The packaged server is a Node single executable, which cannot `import()` a file from disk, so it
loads plugins with `module.createRequire(process.execPath)`. Desktop and dev servers use `import()`.
Only a `.cjs` file loads the same way on both paths, so the manifest rejects other extensions.
Reload clears the `require.cache` entry or changes the `import()` URL; Node keeps the old module
instance in memory until the server restarts.

## State lives beside T3's

Settings go in `<stateDir>/plugins/<id>/settings.json`, storage in `<stateDir>/plugins.sqlite`,
enabled flags in `<stateDir>/plugins.json`. Not in `settings.json`, whose writer re-encodes its
decoded struct and drops unknown keys. Not a migration in `statev2.sqlite`, whose numbered list
refuses to start when a fork migration id collides with an upstream one.

## Ids and manifests

Ids are lowercase because they name directories on case-insensitive filesystems, and have no
underscores so the `plg_<id>_` prefix on plugin MCP tool names belongs to one plugin. Entry paths are
checked lexically; code that reads or serves them must still resolve symlinks. `contributes` rejects
unknown keys, so a plugin written for a newer T3 fails with a reason instead of losing one silently.

## Clients

Desktop and hosted web authenticate `/api` with bearer tokens, which a bare `import(url)` cannot
send. The loader fetches a web bundle with the authenticated fetch and imports a `blob:` URL, so the
desktop CSP allows `blob:` scripts. Bundles reach React and the UI kit through
`globalThis.__t3PluginHost`, not an import map. Mobile release builds cannot load code at all, so
mobile renders settings from the manifest's JSON Schema and declarative contributions only.

Where T3 has a closed union and a `switch` (right panel kinds, settings paths, keybinding commands,
drivers, MCP toolkits), plugins add to a registry that built-ins register into first. Where T3
already has a server-supplied open variant (provider slash commands, dynamic tool items, themes),
plugins use it. Hot paths such as timeline and sidebar rows read a module-level `Map` and re-render
on one list-level version, never a per-row subscription.

## Nothing installed costs nothing

Clients show plugin UI only when the environment advertises `plugins`, and receive plugin state only
when they opt in. Plugins activate after the server is listening.
