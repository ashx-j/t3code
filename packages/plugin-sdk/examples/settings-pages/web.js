// Settings and Usage open in T3's route modal, `[data-app-modal]`. Pinning it to the window edges
// covers the dimmed backdrop too, so no other element needs restyling.
const css = `
[data-app-modal] {
  position: fixed;
  inset: 0;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
`;

export default {
  activate(api) {
    api.injectStyles(css);
  },
};
