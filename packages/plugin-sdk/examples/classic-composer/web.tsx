import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/classic-composer/vite.config.ts` from
// packages/plugin-sdk.
const css = `
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

export default defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("composer.controls", (pieces) => (
      <>
        <div className="classic-composer-pickers">
          {pieces.model}
          {pieces.effort}
          {pieces.access}
        </div>
        <div className="classic-composer-send">
          {pieces.buttons}
          {pieces.attach}
          {pieces.actions}
        </div>
      </>
    ));
  },
});
