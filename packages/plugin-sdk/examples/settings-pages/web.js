// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/settings-pages/web.tsx
var web_default = defineWebPlugin({
  activate(api) {
    api.ui.replace("app.pageFrame", (frame) => frame.page);
    api.ui.replace("app.sidebar", (sidebar) =>
      /* @__PURE__ */ jsxs(Fragment, {
        children: [
          sidebar.header,
          sidebar.nav ?? sidebar.threads,
          sidebar.page === null ? sidebar.footer : sidebar.back,
        ],
      }),
    );
  },
});
export { web_default as default };
