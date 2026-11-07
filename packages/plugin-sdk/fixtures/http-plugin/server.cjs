// Plain CommonJS with no SDK import, so the plugin host loads it as is. The type comes from the SDK.

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    api.http.route("GET", "/hello", (request) => ({
      headers: { "content-type": "text/plain" },
      body: `hello ${request.query.name ?? "world"}`,
    }));
    api.http.route("POST", "/echo", (request) => ({
      status: 201,
      headers: { "content-type": request.headers["content-type"] ?? "text/plain" },
      body: request.body,
    }));
  },
};
