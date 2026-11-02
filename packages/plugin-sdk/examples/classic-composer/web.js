// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/classic-composer/web.tsx
var chevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
var css = `
/* The old row sat 16px in from the card's right and bottom edges (12px on phones), with the
   model picker pulled 8px toward the edge. T3's row is 8px in. */
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
@media (min-width: 40rem) {
  .classic-composer-pickers {
    margin-inline-start: 0;
    margin-block-end: 0.5rem;
  }
  .classic-composer-send {
    margin-inline-end: 0.5rem;
    margin-block-end: 0.5rem;
  }
}

.classic-composer-pickers > button[aria-label^="Permissions"] {
  padding-inline-start: 0.5rem;
}

/* The old pickers ended in a chevron. */
.classic-composer-pickers > button[aria-haspopup]::after {
  content: "";
  width: 0.625rem;
  height: 0.875rem;
  flex-shrink: 0;
  background-color: var(--muted-foreground);
  mask: ${chevron} center / 0.875rem no-repeat;
}

/* Full access showed an open lock before the redesign. */
svg.lucide-shield-off {
  background-color: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 9.9-1'/%3E%3C/svg%3E") center / contain no-repeat;
  & > * {
    display: none;
  }
}

/* A new thread's workspace and branch sat in a drawer tucked under the card, with chevrons. The
   row already names the permissions, so the drawer does not repeat them. */
[data-slot="composer-context-strip"] {
  isolation: isolate;
  width: auto;
  margin: -1rem var(--chat-composer-drawer-inset, 1.375rem) 0;
  padding: 1.25rem 0.5rem 0.25rem;
  gap: 0.25rem;
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border: 1px solid var(--chat-composer-outline);
    border-radius: 0 0 var(--radius-2xl) var(--radius-2xl);
    background-color: var(--chat-composer-glass-surface);
    /* The top 15px sit under the card. */
    mask-image: linear-gradient(transparent 15px, black 15px);
  }
  & button[aria-haspopup]:not([aria-label^="Permissions"])::after {
    content: "";
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    background-color: currentColor;
    mask: ${chevron} center / contain no-repeat;
  }
  & button[aria-label^="Permissions"] {
    display: none;
  }
}
.dark [data-slot="composer-context-strip"]::before {
  background-color: color-mix(
    in oklab,
    var(--chat-composer-glass-surface) var(--glass-opacity, 100%),
    transparent
  );
  background-image:
    linear-gradient(transparent 16px, rgb(0 0 0 / 18%) 16px, transparent 26px),
    linear-gradient(rgb(255 255 255 / 1%), rgb(255 255 255 / 1%));
  -webkit-backdrop-filter: blur(var(--glass-blur, 0)) saturate(var(--glass-saturation, 1));
  backdrop-filter: blur(var(--glass-blur, 0)) saturate(var(--glass-saturation, 1));
}
`;
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("composer.controls", (pieces) =>
      /* @__PURE__ */ jsxs(Fragment, {
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
