// \0t3-plugin-host:@t3tools/plugin-sdk/ui
var host$2 = globalThis.__t3PluginHost.ui;
var read$2 = (name) => host$2[name];
var Switch = /* @__PURE__ */ read$2("Switch");
// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react
var host$1 = globalThis.__t3PluginHost.react;
var read$1 = (name) => host$1[name];
var useState = /* @__PURE__ */ read$1("useState");
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/classic-composer/web.tsx
var css = `
.classic-composer {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  container: classic-composer / inline-size;
}
.classic-composer-pickers {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  margin-inline-start: -0.25rem;
  margin-block-end: 0.25rem;
}
.classic-composer-send {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  margin-inline: 0.5rem 0.25rem;
  margin-block-end: 0.25rem;
}
@container classic-composer (min-width: 28rem) {
  .classic-composer-pickers {
    margin-inline-start: 0;
    margin-block-end: 0.5rem;
  }
  .classic-composer-send {
    margin-inline-end: 0.5rem;
    margin-block-end: 0.5rem;
  }
}

.classic-composer-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  & p {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  & p + p {
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 400;
  }
}
`;
var COLLAPSE_KEY = "classic-composer:collapse-on-scroll";
/** Whether the composer folds while the timeline is scrolled up. On until turned off here. */
var collapseOnScroll = () => localStorage.getItem(COLLAPSE_KEY) !== "off";
function CollapseSetting(props) {
  const [on, setOn] = useState(collapseOnScroll);
  return /* @__PURE__ */ jsxs("div", {
    className: "classic-composer-setting",
    children: [
      /* @__PURE__ */ jsxs("div", {
        children: [
          /* @__PURE__ */ jsx("p", { children: "Collapse composer on scroll" }),
          /* @__PURE__ */ jsx("p", {
            children:
              "Rests an existing thread's composer as one line while you scroll up the conversation. Focus it or scroll back to the end to expand it again.",
          }),
        ],
      }),
      /* @__PURE__ */ jsx(Switch, {
        "aria-label": "Collapse composer on scroll",
        checked: on,
        onCheckedChange: (checked) => {
          setOn(checked);
          props.onChange(checked);
        },
      }),
    ],
  });
}
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.composer.setCollapseOnScroll(collapseOnScroll());
    api.settings.registerPanel(() =>
      /* @__PURE__ */ jsx(CollapseSetting, {
        onChange: (on) => {
          localStorage.setItem(COLLAPSE_KEY, on ? "on" : "off");
          api.composer.setCollapseOnScroll(on);
        },
      }),
    );
    api.ui.replace("composer.controls", (pieces) =>
      /* @__PURE__ */ jsxs("div", {
        className: "classic-composer",
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "classic-composer-pickers",
            children: [pieces.model, pieces.effort, pieces.access],
          }),
          /* @__PURE__ */ jsxs("div", {
            className: "classic-composer-send",
            children: [pieces.buttons, pieces.attach, pieces.actions],
          }),
        ],
      }),
    );
  },
});
export { web_default as default };
