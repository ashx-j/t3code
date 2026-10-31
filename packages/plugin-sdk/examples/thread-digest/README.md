# Thread digest

A server-only plugin. When a run ends, it adds a note to the thread saying how the run ended and how
long it took. Runs that ended while the plugin was off are noted when it starts again.

Install it from **Settings → Plugins → Add plugin** with this folder's path. Its one setting limits
the notes to runs that failed or were stopped.

It uses `api.turns.afterRunCompleted`, `api.threads.notify` and `api.settings.get`.
