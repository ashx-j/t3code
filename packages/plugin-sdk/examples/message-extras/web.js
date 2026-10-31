// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/message-extras/web.tsx
var css = `
.message-extras-count { margin-top: 0.25rem; font-size: 0.6875rem; color: var(--muted-foreground); }
.message-extras-terminal {
  margin: 0;
  max-height: 20rem;
  overflow: auto;
  border-radius: 0.375rem;
  background: #0c0c0c;
  padding: 0.5rem 0.75rem;
  color: #d4d4d4;
  font: 0.75rem/1.5 var(--font-mono, monospace);
  white-space: pre-wrap;
}
.message-extras-terminal b { color: #7ee787; font-weight: 400; }
`;
var countWords = (text) => text.split(/\s+/).filter(Boolean).length;
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("message.assistant", (message) =>
      /* @__PURE__ */ jsxs(Fragment, {
        children: [
          message.original,
          message.streaming
            ? null
            : /* @__PURE__ */ jsxs("p", {
                className: "message-extras-count",
                children: [countWords(message.text), " words"],
              }),
        ],
      }),
    );
    api.ui.replace("timeline.item", (step) =>
      step.item.type === "command_execution" && typeof step.item.input === "string"
        ? /* @__PURE__ */ jsxs("pre", {
            className: "message-extras-terminal",
            children: [
              /* @__PURE__ */ jsxs("b", { children: ["$ ", step.item.input] }),
              step.output ? `\n${step.output}` : null,
            ],
          })
        : step.original,
    );
  },
});
export { web_default as default };
