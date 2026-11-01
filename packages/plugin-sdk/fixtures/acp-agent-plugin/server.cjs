/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    return api.providers.registerAcpAgent({
      kind: "echoAcp",
      label: "Echo ACP",
      command: process.execPath,
      args: [`${api.rootDir}/agent.cjs`],
    });
  },
};
