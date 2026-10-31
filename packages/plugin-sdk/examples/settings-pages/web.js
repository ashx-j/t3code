// Settings and Usage open in place of the thread, beside the sidebar, instead of over it.
export default {
  activate(api) {
    api.ui.replace("app.pageFrame", (frame) => frame.page);
  },
};
