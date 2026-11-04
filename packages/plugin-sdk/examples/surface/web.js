// Surface's shapes that a theme file can't set yet, each reaching T3's markup through its most
// stable hook; the README lists each with the seam that would replace it. Rules apply only under
// the Surface theme, in both modes, with dark-only fills under .dark. A rule whose hook T3
// renames stops matching.
const css = `
:root[data-theme-id="surface"] {
  /* Tailwind emits its radius and text size tokens only while T3's own code uses them, so each
     one read here falls back to T3's value. */

  /* 1. Buttons, inputs, pickers and sidebar rows round like cards. The theme's radius only sets
        --radius, and T3 keeps a separate --control-radius. */
  --control-radius: 0.625rem;

  /* 2. The sidebar's edge is the same hairline as everything else, where T3 mixes it from the
        sidebar's text color for a theme. In dark the sidebar sits on its own darker gray, cards
        included, with a stronger hover fill. T3 maps --background and --card in the sidebar to the
        canvas and surface roles. */
  & [data-app-sidebar] {
    border-color: var(--sidebar-border);
  }
  &.dark [data-app-sidebar] {
    /* Repeated, since T3's dark edge outranks the rule above. */
    border-color: var(--sidebar-border);
    --background: var(--sidebar);
    --card: var(--sidebar);
    --accent: var(--sidebar-row-active);
  }

  /* 3. The composer card, the banners and /, @ and $ menus above it, and tool error icons keep
        T3's own colors. For a theme, T3 mixes their outlines and the card's top highlight from
        the input and toolbar colors, fills them with the raised surface, which is 20% white in
        light, and takes the error icon from errorForeground. Error and warning banners keep the
        edge T3 tints for them. Hooks: data-slot="composer-shell", where T3 sets them for the
        card, and data-composer-banner-surface with its data-variant for the banners and menus. */
  &:not(.dark) {
    --tool-error-icon: var(--error);
    & [data-slot="composer-shell"] {
      --chat-composer-glass-surface: var(--card);
      --chat-composer-outline: rgb(0 0 0 / 8%);
    }
    & [data-composer-banner-surface] {
      --chat-composer-attached-surface: var(--chat-composer-glass-surface, var(--card));
    }
    & [data-composer-banner-surface]:is([data-variant="default"], [data-variant="info"], [data-variant="success"]) {
      --chat-composer-attached-outline: var(
        --chat-composer-outline,
        color-mix(in srgb, var(--contrast-foreground) 8%, transparent)
      );
    }
  }
  &.dark {
    --tool-error-icon: #fca5a5;
    & [data-slot="composer-shell"] {
      --chat-composer-outline: rgb(255 255 255 / 5%);
      --chat-composer-highlight: rgb(255 255 255 / 3%);
    }
    & [data-composer-banner-surface]:is([data-variant="default"], [data-variant="info"], [data-variant="success"]) {
      --chat-composer-attached-outline: var(--chat-composer-outline, rgb(255 255 255 / 5%));
    }
  }

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
    border-radius: var(--radius-2xl, calc(var(--radius) + 8px));
    background: var(--card);
    /* The composer's own shadows. T3 builds them into its classes, so no variable carries them. */
    box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
  }
  &.dark [data-thread-details-card] section {
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
    font-size: var(--text-xs, 0.75rem);
    line-height: var(--text-xs--line-height, calc(1 / 0.75));
    font-weight: 400;
  }
  & [data-thread-details-card] section > :last-child {
    padding: 0.125rem;
    border-radius: var(--radius-xl, calc(var(--radius) + 4px));
    background: var(--surface-raised);
  }

  /* 5. Grouped settings are solid cards. Hook: data-slot="settings-group", and the grouped
        variant's own fill class, so a plain group never matches. The provider detail pane keeps
        T3's flat sections. */
  & [data-slot="settings-group"][class~="bg-card/40"]:not([data-provider-detail] *) {
    border-color: var(--border);
    border-radius: var(--radius-2xl, calc(var(--radius) + 8px));
    background: var(--card);
  }

  /* 6. Segmented tabs: a framed track, and in dark a sunken track with a raised selected tab.
        Hook: data-slot and data-variant="segmented" on T3's toggle group, and data-variant on
        its tabs, which a tooltip trigger keeps when its own data-slot replaces the toggle's. */
  & [data-slot="toggle-group"][data-variant="segmented"] {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl, calc(var(--radius) + 4px));
  }
  & [data-slot="toggle-group"][data-variant="segmented"] > [data-variant="segmented"] {
    border-radius: var(--radius-lg, var(--radius));
    &::before {
      border-radius: calc(var(--radius-lg, var(--radius)) - 1px);
    }
  }
  &.dark [data-slot="toggle-group"][data-variant="segmented"] {
    background: rgb(0 0 0 / 25%);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 35%);
    & > [data-variant="segmented"][data-pressed] {
      background: var(--surface-raised);
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / 7%),
        0 1px 3px rgb(0 0 0 / 45%);
    }
  }

  /* 7. The stop button is a dim rounded square with a red icon instead of a red circle. T3 gives
        it no hook but its label, so this is the one rule that matches text. */
  & button[aria-label="Stop generation"] {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, var(--radius));
    background: rgb(0 0 0 / 5%);
    color: var(--destructive);
    box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
    &:hover {
      background: rgb(0 0 0 / 10%);
    }
    &:active {
      box-shadow: none;
    }
  }
  &.dark button[aria-label="Stop generation"] {
    background: rgb(0 0 0 / 45%);
    &:hover {
      background: rgb(0 0 0 / 65%);
    }
  }

  /* 8. Chat code blocks keep their own fill and edge, a light gray card in light and a faint fill
        with no edge in dark, where T3 paints them with the theme's code colors. Diffs and T3's
        other code surfaces keep the code colors. revert-layer hands each property back to the
        block's own classes. Hook: the chat-markdown-codeblock class inside .chat-markdown and
        .composer-tiptap, T3's own selector for the themed look. */
  & :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock {
    border-color: revert-layer;
    background-color: revert-layer;
  }
}
`;

export default {
  activate(api) {
    api.injectStyles(css);
  },
};
