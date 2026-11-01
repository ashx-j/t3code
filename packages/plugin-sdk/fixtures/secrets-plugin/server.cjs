/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register(
      "askToken",
      async (input) => {
        const { threadId } = /** @type {{ threadId: string }} */ (input);
        const answer = await api.secrets.request({
          threadId,
          label: "Deploy token",
          reason: "Used to deploy to staging.",
        });
        // A real plugin keeps the value to itself; the test checks what arrived.
        return answer.status === "saved" ? { saved: answer.value } : { status: answer.status };
      },
      { access: "write" },
    );
  },
};
