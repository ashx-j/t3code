// Surface's shapes. Every rule is scoped to the Surface theme, so picking another theme in
// Settings brings back T3's own look without disabling the plugin.
const css = `
:root[data-theme-id="surface"] {
  --radius: 0.625rem;
  --control-radius: 0.625rem;

  /* The details panel drops its frosted glass: each section is its own card, rows sit on a
     raised layer inside it, and a gap replaces the divider between sections. */
  & [data-thread-details-card] {
    border-color: transparent;
    background: transparent;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  & [data-thread-details-card] section {
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-2xl);
    background: var(--card);
    box-shadow: 0 14px 32px -18px rgb(0 0 0 / 75%);
  }
  & [data-thread-details-card] section:not(:has(> div:last-child:empty)) ~ section {
    margin-top: 0.25rem;
  }
  & [data-thread-details-card] section:not(:has(> div:last-child:empty)) ~ section[class~="border-border/65"] {
    margin-top: 0.5rem;
  }
  & [data-thread-details-card] section > div:first-child {
    margin-bottom: 0;
  }
  & [data-thread-details-card] section h3 {
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
    font-weight: 400;
  }
  & [data-thread-details-card] section > :last-child {
    padding: 0.125rem;
    border-radius: var(--radius-xl);
    background: var(--surface-raised);
  }

  /* Grouped settings are solid cards. The plain variant is the one with space-y-1. */
  & [data-slot="settings-group"]:not(.space-y-1) {
    border-color: var(--border);
    border-radius: var(--radius-2xl);
    background: var(--card);
  }

  /* Segmented tabs: a sunken track, and the selected tab looks raised. */
  & [data-slot="toggle-group"][data-variant="segmented"] {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: rgb(0 0 0 / 25%);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 35%);
  }
  & [data-slot="toggle"][data-variant="segmented"] {
    border-radius: var(--radius-lg);
    &::before {
      border-radius: calc(var(--radius-lg) - 1px);
    }
    &[data-pressed] {
      background: var(--surface-raised);
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / 7%),
        0 1px 3px rgb(0 0 0 / 45%);
    }
  }

  /* A dark square with a red icon instead of a red circle. */
  & button[aria-label="Stop generation"] {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(0 0 0 / 45%);
    color: var(--destructive);
    box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
    &:hover {
      background: rgb(0 0 0 / 65%);
    }
    &:active {
      box-shadow: none;
    }
  }
}
`;

export default {
  activate(api) {
    api.injectStyles(css);
  },
};
