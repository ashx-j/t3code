/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.rpc.register("greeting", () => "Hello from the server half of hello-web.", {
      access: "read",
    });
  },
};
