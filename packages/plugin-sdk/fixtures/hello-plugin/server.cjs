// Plain CommonJS with no SDK import, so the plugin host loads it as is. The type comes from the SDK.

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.log.info("hello-plugin activated");
    api.rpc.register(
      "ping",
      async (input) => {
        const settings = await api.settings.get();
        const greeting = typeof settings.greeting === "string" ? settings.greeting : "hello";
        return { pong: input ?? null, greeting };
      },
      { access: "read" },
    );
    api.rpc.register(
      "count",
      async () => {
        const current = await api.storage.get("count");
        const next = (typeof current === "number" ? current : 0) + 1;
        await api.storage.set("count", next);
        api.rpc.publish("counted", next);
        return next;
      },
      { access: "write" },
    );
    api.onDeactivate(() => api.storage.set("deactivated", true));
    void (async () => {
      for await (const settings of api.settings.changes()) api.rpc.publish("settings", settings);
    })();
  },
};
