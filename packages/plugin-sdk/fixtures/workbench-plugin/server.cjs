/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.turns.beforeDispatch((message) =>
      message.text.includes("#context")
        ? { appendText: "Context from workbench-plugin." }
        : undefined,
    );

    api.schedule.every(1000, async () => {
      const ticks = await api.storage.get("ticks");
      const next = (typeof ticks === "number" ? ticks : 0) + 1;
      await api.storage.set("ticks", next);
      api.rpc.publish("ticks", next);
    });

    void (async () => {
      for await (const stored of api.events.stored({ types: ["thread.metadata-updated"] })) {
        await api.storage.set("lastEvent", { sequence: stored.sequence, type: stored.type });
        api.rpc.publish("events", stored.type);
      }
    })();

    api.rpc.register(
      "overview",
      async () => {
        const [environment, threads, projects] = await Promise.all([
          api.server.environment(),
          api.threads.list(),
          api.projects.list(),
        ]);
        return {
          version: api.server.version,
          environment: environment.label ?? null,
          threads: threads.length,
          projects: projects.length,
          firstThreadId: threads[0]?.id ?? null,
        };
      },
      { access: "read" },
    );
    api.rpc.register(
      "renameThread",
      async (input) => {
        const { threadId, title } = /** @type {{ threadId?: unknown, title?: unknown }} */ (
          input ?? {}
        );
        if (typeof threadId !== "string" || typeof title !== "string") {
          throw new TypeError("Expected { threadId, title }.");
        }
        await api.threads.rename(threadId, title);
        return null;
      },
      { access: "write" },
    );
    api.rpc.register(
      "noteThread",
      async (input) => {
        const { threadId } = /** @type {{ threadId?: unknown }} */ (input ?? {});
        if (typeof threadId !== "string") throw new TypeError("Expected { threadId }.");
        await api.threads.notify({ threadId, summary: "Checked", outcome: "completed" });
        return null;
      },
      { access: "write" },
    );
    api.rpc.register(
      "lastEvent",
      () => api.storage.get("lastEvent").then((value) => value ?? null),
      {
        access: "read",
      },
    );
  },
};
