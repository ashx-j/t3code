/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    // The same package and version the ACP Registry lists for Claude Agent.
    return api.providers.registerAcpAgent({
      kind: "claudeAgentAcp",
      label: "Claude Agent (ACP)",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"],
    });
  },
};
