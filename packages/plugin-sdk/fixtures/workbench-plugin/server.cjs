/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.turns.beforeDispatch((message) => {
      if (message.text.includes("#secret")) return { block: "Remove the secret first." };
      if (message.text.startsWith("#shout ")) return { text: message.text.slice(7).toUpperCase() };
      if (message.text.includes("#context"))
        return { appendText: "Context from workbench-plugin." };
      return undefined;
    });

    // Allows `git status`, turns down `rm` with a reason, takes each question's first option, and
    // leaves everything else to the user.
    api.turns.onRuntimeRequest((request) => {
      if (request.kind === "user_input") {
        return {
          answers: Object.fromEntries(
            request.questions.map((question) => [question.id, question.options[0]?.label ?? "yes"]),
          ),
        };
      }
      if (request.kind !== "command") return undefined;
      if (request.prompt?.startsWith("git status")) return { decision: "accept" };
      if (request.prompt?.startsWith("rm ")) {
        return { decision: "decline", feedback: "Workbench does not allow rm." };
      }
      return undefined;
    });

    api.slashCommands.register(
      { name: "deploy", description: "Deploy to an environment", inputHint: "environment" },
      ({ args }) =>
        args === ""
          ? { block: "Name an environment, for example /deploy staging." }
          : { text: `Deploy to ${args} and report back.` },
    );
    api.slashCommands.register({ name: "status", description: "Show the deploy status" }, () => ({
      reply: "**staging** is up to date.",
    }));

    api.textGeneration.register("threadTitle", ({ message }) =>
      message.startsWith("#titled ") ? { title: `Workbench: ${message.slice(8)}` } : undefined,
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
