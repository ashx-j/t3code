// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/classic-composer/web.tsx
var css = `
.classic-composer-pickers {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 0.125rem;
}
/* The old pickers ended in a chevron. */
.classic-composer-pickers > button[aria-haspopup]::after {
  content: "";
  width: 0.75rem;
  height: 0.75rem;
  flex-shrink: 0;
  background-color: currentColor;
  opacity: 0.6;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")
    center / contain no-repeat;
}
.classic-composer-send {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  margin-inline-start: 0.5rem;
}
`;
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("composer.controls", (pieces) =>
      /* @__PURE__ */ jsxs(Fragment, {
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "classic-composer-pickers",
            children: [pieces.model, pieces.effort, pieces.access],
          }),
          /* @__PURE__ */ jsxs("div", {
            className: "classic-composer-send",
            children: [pieces.attach, pieces.actions],
          }),
        ],
      }),
    );
  },
});
export { web_default as default };
