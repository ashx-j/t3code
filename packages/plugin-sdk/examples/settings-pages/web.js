// Settings and Usage open in place of the thread, beside the sidebar. While Settings is open, the
// sidebar lists its sections in place of the threads; on either page, Back replaces its buttons.
const { createElement, Fragment } = globalThis.__t3PluginHost.react;

export default {
  activate(api) {
    api.ui.replace("app.pageFrame", (frame) => frame.page);
    api.ui.replace("app.sidebar", (sidebar) =>
      createElement(
        Fragment,
        null,
        sidebar.header,
        sidebar.nav ?? sidebar.threads,
        sidebar.page === null ? sidebar.footer : sidebar.back,
      ),
    );
  },
};
