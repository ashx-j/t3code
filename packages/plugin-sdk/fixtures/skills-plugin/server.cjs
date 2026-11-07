/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.agents.addInstructions("Write release notes in the past tense.");
  },
};
