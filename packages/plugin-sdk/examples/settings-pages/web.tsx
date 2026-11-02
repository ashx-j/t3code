import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/settings-pages/vite.config.ts` from
// packages/plugin-sdk.
const wrapper = `[data-slot="sidebar-wrapper"]`;

// The page's header lines up with the sidebar's top row. Where the sidebar shows beside the page
// (from 768px up, while it is open), its Back button replaces the page's close button.
const css = `
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

export default defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("app.pageFrame", (frame) => frame.page);
    api.ui.replace("app.sidebar", (sidebar) => (
      <>
        {sidebar.header}
        {sidebar.nav ?? sidebar.threads}
        {sidebar.page === null ? sidebar.footer : sidebar.back}
      </>
    ));
  },
});
