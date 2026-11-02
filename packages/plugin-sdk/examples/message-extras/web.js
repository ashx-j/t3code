// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/message-extras/web.tsx
var css = `
.message-extras-count { margin-top: 0.25rem; font-size: 0.6875rem; color: var(--muted-foreground); }
.message-extras-terminal {
  margin: 0;
  max-height: 20rem;
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--terminal-background);
  padding: 0.5rem 0.75rem;
  color: var(--terminal-foreground);
  font: 0.75rem/1.5 var(--font-mono, monospace);
  white-space: pre-wrap;
}
.message-extras-terminal b { color: var(--success-foreground); font-weight: 400; }
.message-extras-diff { display: flex; min-height: 0; flex: 1; flex-direction: column; }
.message-extras-diff-summary { padding: 0.25rem 0.75rem; font-size: 0.6875rem; color: var(--muted-foreground); }
`;
var summarizePatch = (patch) => {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n"))
    if (line.startsWith("+++ ")) files += 1;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed += 1;
  return `${files} ${files === 1 ? "file" : "files"}, +${added} -${removed}`;
};
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
    api.ui.replace("diff.view", (diff) =>
      /* @__PURE__ */ jsxs("div", {
        className: "message-extras-diff",
        children: [
          diff.patch
            ? /* @__PURE__ */ jsx("p", {
                className: "message-extras-diff-summary",
                children: summarizePatch(diff.patch),
              })
            : null,
          diff.original,
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
