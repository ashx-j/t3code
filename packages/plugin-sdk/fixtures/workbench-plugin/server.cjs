/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
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
      "tidyThread",
      async (input) => {
        const { threadId, projectId } = /** @type {{ threadId?: unknown, projectId?: unknown }} */ (
          input ?? {}
        );
        if (typeof threadId !== "string" || typeof projectId !== "string") {
          throw new TypeError("Expected { threadId, projectId }.");
        }
        await api.threads.archive(threadId);
        await api.threads.unarchive(threadId);
        await api.threads.snooze(threadId, "2026-11-01T09:00:00.000Z");
        await api.threads.unsnooze(threadId);
        await api.threads.settle(threadId);
        await api.threads.unsettle(threadId);
        await api.threads.delete(threadId);
        const followUp = await api.threads.create({
          projectId,
          title: "Follow-up",
          message: "Check the deploy.",
        });
        const project = await api.projects.update(projectId, { pinned: true });
        return { threadId: followUp.threadId, project: project.title ?? null };
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
