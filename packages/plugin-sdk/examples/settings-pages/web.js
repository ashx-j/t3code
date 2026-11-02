// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/settings-pages/web.tsx
var wrapper = `[data-slot="sidebar-wrapper"]`;
var css = `
${wrapper} > [data-app-route-page] header:has(button[aria-label="Close"]) {
  min-height: var(--workspace-topbar-height, 3.25rem);
  height: auto;
  border-bottom-color: transparent;
}
@media (min-width: 48rem) {
  ${wrapper}[data-sidebar-state="expanded"] > [data-app-route-page] header:has(button[aria-label="Close"]) {
    padding-inline-end: 1.25rem;
    & button[aria-label="Close"] {
      display: none;
    }
  }
}
`;
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
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
