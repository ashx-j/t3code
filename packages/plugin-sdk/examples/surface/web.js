// Surface's shapes that a theme file can't set yet. Each rule reaches into T3's markup through
// the most stable hook it has; the README lists each with the seam that would replace it. Every
// rule is scoped to the Surface theme, and one whose hook T3 renames stops matching.
const css = `
:root[data-theme-id="surface"] {
  /* 1. Buttons, inputs, pickers and sidebar rows round like cards. The theme's radius only sets
        --radius, and T3 keeps a separate --control-radius. */
  --control-radius: 0.625rem;

  /* 2. The sidebar sits on its own darker gray, cards included, with a stronger hover fill and
        the same hairline edge as everything else. T3 maps --background and --card in the sidebar
        to the canvas and surface roles. */
  & [data-app-sidebar] {
    border-color: var(--sidebar-border);
    --background: var(--sidebar);
    --card: var(--sidebar);
    --accent: var(--sidebar-row-active);
  }

  /* 3. The composer card keeps a plain white hairline and top highlight. For a theme, T3 mixes
        them from the input color. Hook: data-slot="composer-shell", where T3 sets them. Tool
        errors keep their light red icon, which T3 takes from errorForeground for a theme. */
  & [data-slot="composer-shell"] {
    --chat-composer-outline: rgb(255 255 255 / 5%);
    --chat-composer-highlight: rgb(255 255 255 / 3%);
  }
  --tool-error-icon: var(--color-red-300);

  /* 4. Thread details: each section is its own card with its rows on a raised layer, and a gap
        replaces the divider, instead of one frosted card. Hooks: the card's
        data-thread-details-card and its section elements. */
  & [data-thread-details-card] {
    border-width: 0;
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
  /* A section that renders no rows is hidden, so only a section after one with rows gets a gap.
     Sections T3 divides get the wider gap. T3 marks those only with their divider's color class,
     so if it goes, every gap is the narrow one. */
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

  /* 5. Grouped settings are solid cards. Hook: data-slot="settings-group", and the grouped
        variant's own fill class, so a plain group never matches. The provider detail pane keeps
        T3's flat sections. */
  & [data-slot="settings-group"][class~="bg-card/40"]:not([data-provider-detail] *) {
    border-color: var(--border);
    border-radius: var(--radius-2xl);
    background: var(--card);
  }

  /* 6. Segmented tabs: a sunken track, and the selected tab looks raised. Hook: data-slot and
        data-variant="segmented" on T3's toggle group. */
  & [data-slot="toggle-group"][data-variant="segmented"] {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: rgb(0 0 0 / 25%);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 35%);
  }
  & [data-slot="toggle-group"][data-variant="segmented"] > [data-slot="toggle"] {
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

  /* 7. The stop button is a dark rounded square with a red icon instead of a red circle. T3 gives
        it no hook but its label, so this is the one rule that matches text. */
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
