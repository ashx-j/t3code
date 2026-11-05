import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/settings-pages/vite.config.ts` from
// packages/plugin-sdk.
export default defineWebPlugin({
  activate(api) {
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
