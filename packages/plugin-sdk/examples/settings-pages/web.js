// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/settings-pages/web.tsx
var wrapper = `[data-slot="sidebar-wrapper"]`;
var expanded = `${wrapper}[data-sidebar-state="expanded"]`;
var css = `
${wrapper} > [data-app-route-page] header:has(button[aria-label="Close"]) {
  min-height: var(--workspace-topbar-height, 3.25rem);
  height: auto;
  border-bottom-color: transparent;
}
.settings-pages-back {
  display: none;
}
@media (min-width: 48rem) {
  ${expanded} > [data-app-route-page] header:has(button[aria-label="Close"]) {
    padding-inline-end: 1.25rem;
    & button[aria-label="Close"] {
      display: none;
    }
  }

  /* Settings lists its sections where the thread list was, under the sidebar's toggle. */
  ${expanded}:has(> [data-app-route-page][aria-label="Settings"]) {
    & > [data-slot="sidebar"] {
      display: none;
    }
    & [data-workspace-area="settings-nav"] {
      width: var(--sidebar-width);
      padding-block: var(--workspace-topbar-height, 3.25rem) 2.75rem;
    }
  }
  ${wrapper}[data-sidebar-state="collapsed"] > [data-app-route-page][aria-label="Settings"] [data-workspace-area="settings-nav"] {
    display: none;
  }

  /* Usage keeps the thread list; Back replaces the footer's Settings, Pull requests and Usage. */
  ${expanded}:has(> [data-app-route-page]) [data-sidebar="footer"] [data-sidebar="menu-item"]:has(> :is([aria-label="Settings"], [aria-label="Pull requests"], [aria-label="Usage"])) {
    display: none;
  }

  ${expanded} > .settings-pages-back {
    position: fixed;
    z-index: 11;
    inset-inline-start: var(--sidebar-content-inset, 0.5rem);
    bottom: var(--sidebar-content-inset, 0.5rem);
    display: flex;
    width: calc(var(--sidebar-width) - 2 * var(--sidebar-content-inset, 0.5rem) - 2.25rem);
    height: 2rem;
    align-items: center;
    gap: var(--sidebar-control-gap, 0.5rem);
    padding-inline: var(--sidebar-row-content-inset, 0.625rem);
    border-radius: var(--control-radius);
    color: color-mix(in oklab, var(--sidebar-muted-foreground) 80%, transparent);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: 500;
    cursor: pointer;
    & svg {
      flex-shrink: 0;
      color: var(--sidebar-icon-color, currentColor);
    }
    &:hover,
    &:active {
      background: var(--sidebar-row-hover);
      color: var(--sidebar-foreground);
      & svg {
        color: var(--sidebar-foreground);
      }
    }
    &:active {
      background: var(--sidebar-row-active);
    }
    &:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: -2px;
    }
  }
}
`;
function ArrowLeftIcon() {
  return /* @__PURE__ */ jsxs("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    children: [
      /* @__PURE__ */ jsx("path", { d: "m12 19-7-7 7-7" }),
      /* @__PURE__ */ jsx("path", { d: "M19 12H5" }),
    ],
  });
}
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("app.pageFrame", (frame) =>
      /* @__PURE__ */ jsxs(Fragment, {
        children: [
          frame.page,
          /* @__PURE__ */ jsxs("button", {
            type: "button",
            className: "settings-pages-back",
            onClick: () => frame.close(),
            children: [
              /* @__PURE__ */ jsx(ArrowLeftIcon, {}),
              /* @__PURE__ */ jsx("span", { children: "Back" }),
            ],
          }),
        ],
      }),
    );
  },
});
export { web_default as default };
