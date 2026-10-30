// Plain CommonJS with no SDK import, so the plugin host loads it as is. The type comes from the SDK.

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.log.info("hello-plugin activated");
    api.rpc.register("ping", (input) => ({ pong: input ?? null }), { access: "read" });
  },
};
