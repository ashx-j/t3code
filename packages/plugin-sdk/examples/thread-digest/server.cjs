/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.turns.afterRunCompleted(async ({ threadId, status, run }) => {
      // A rolled back run is hidden from the thread, so a note under it would be too.
      if (status === "rolled_back") return;
      const settings = await api.settings.get();
      if (settings.onlyProblems === true && status === "completed") return;
      const started = Date.parse(String(run.workStartedAt ?? run.startedAt));
      const ended = Date.parse(String(run.completedAt));
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
