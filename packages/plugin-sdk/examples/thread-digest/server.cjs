/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.turns.afterRunCompleted("digest", async ({ threadId, status, startedAt, completedAt }) => {
      // A rolled back run is hidden from the thread, so a note under it would be too. A queued
      // message cancelled before it ran never started a turn.
      if (status === "rolled_back" || startedAt === null) return;
      const settings = await api.settings.get();
      if (settings.onlyProblems === true && status === "completed") return;
      const started = Date.parse(startedAt);
      const ended = completedAt === null ? Number.NaN : Date.parse(completedAt);
      const seconds = Math.round((ended - started) / 1000);
      const took = Number.isFinite(seconds) ? ` in ${seconds} s` : "";
      await api.threads.notify({
        threadId,
        summary: status === "completed" ? `Run finished${took}` : `Run ${status}${took}`,
        outcome: status === "completed" ? "completed" : status === "failed" ? "failed" : "updated",
      });
    });
  },
};
