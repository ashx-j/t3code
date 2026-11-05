/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register(
      "branches",
      async (input) => {
        const { projectId } = /** @type {{ projectId: string }} */ (input);
        const worktrees = await api.worktrees.list(projectId);
        return worktrees.map((worktree) => worktree.branch);
      },
      { access: "read" },
    );
  },
};
