import { Switch } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin, type WebPluginParts } from "@t3tools/plugin-sdk/web";
import { useLayoutEffect, useRef, useState } from "react";

// Built to web.js by `vp build --config examples/classic-composer/vite.config.ts` from
// packages/plugin-sdk.

const chevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
const lockOpen = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 9.9-1'/%3E%3C/svg%3E")`;

// The plugin's own elements. The old row sat 16px in from the card's right and bottom edges, and
// 12px in a narrow composer with the model picker pulled 4px toward the edge. T3 already insets
// the row by 8px.
const css = `
.classic-composer {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  container: classic-composer / inline-size;
}
.classic-composer-pickers {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  margin-inline-start: -0.25rem;
  margin-block-end: 0.25rem;
}
.classic-composer-effort,
.classic-composer-access {
  display: contents;
}
.classic-composer-send,
.classic-composer-folded {
  display: flex;
  min-width: 0;
  align-items: center;
  margin-inline-end: 0.25rem;
  margin-block-end: 0.25rem;
}
.classic-composer-send {
  flex-shrink: 0;
  gap: 0.5rem;
  margin-inline-start: 0.5rem;
}
.classic-composer-folded {
  flex: 1;
}
@container classic-composer (min-width: 28rem) {
  .classic-composer-pickers {
    margin-inline-start: 0;
    margin-block-end: 0.5rem;
  }
  .classic-composer-send,
  .classic-composer-folded {
    margin-inline-end: 0.5rem;
    margin-block-end: 0.5rem;
  }
}

/* As the row narrows, effort and permissions drop their labels like the old row's did. */
.classic-composer:is([data-fold="access-icon"], [data-fold="icons"]) .classic-composer-access,
.classic-composer[data-fold="icons"] .classic-composer-effort {
  & [data-composer-control-label] {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

.classic-composer-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  & p {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  & p + p {
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 400;
  }
}

/* --- Rules that reach into T3's markup. T3 has no seam for these yet; the README lists each one
   with the seam that would replace it. Each matches a hook T3 sets for its own code, so when one
   is renamed the rule stops matching and T3's own look shows. --- */

/* 1. Hook: data-chat-composer-actions and data-chat-composer-controls, which T3's composer reads.
      A narrow row hands over to T3's own row, the only one that folds pickers into a menu, and
      puts the pickers back on the left. */
.classic-composer-folded {
  & [data-chat-composer-actions="right"] {
    display: contents;
  }
  & [data-chat-composer-controls="footer"] {
    order: -1;
    justify-content: flex-start;
    margin-inline: -0.25rem 0.5rem;
  }
}
@container classic-composer (min-width: 28rem) {
  .classic-composer-folded [data-chat-composer-controls="footer"] {
    margin-inline-start: 0;
  }
}

/* 2. Hook: data-chat-provider-model-picker, and data-composer-shortcut, which T3's keyboard
      shortcuts use to find the effort and permissions pickers. The old pickers ended in a
      chevron, 8px in from their edge. In T3's folded row, its menu button keeps no chevron. The
      model's name stays whole, so a narrowing row folds effort and permissions first. */
.classic-composer-pickers > [data-chat-provider-model-picker] {
  flex-shrink: 0;
}
.classic-composer
  :is(
    [data-chat-provider-model-picker],
    .classic-composer-pickers [data-composer-shortcut],
    [data-resting-block] [data-composer-shortcut]
  ) {
  padding-inline: 0.5rem;
  &::after {
    content: "";
    width: 0.625rem;
    height: 0.875rem;
    flex-shrink: 0;
    background-color: var(--icon-muted);
    mask: ${chevron} center / 0.875rem no-repeat;
  }
}

/* 3. Hook: the Lucide class on T3's Full access icon, the only thing that marks it. Full access
      showed an open lock before the redesign. Here and in every menu that lists it. */
svg.lucide-shield-off {
  background-color: currentColor;
  mask: ${lockOpen} center / contain no-repeat;
  & > * {
    display: none;
  }
}

/* 4. Hook: data-slot="composer-context-strip", with data-composer-context-control and
      data-slot="combobox-trigger" on its pickers. A new thread's workspace and branch sat in a
      drawer tucked under the card, with chevrons. The row already names the permissions, so the
      drawer doesn't repeat them; the strip's permissions chip is marked only by its label. */
[data-slot="composer-context-strip"] {
  isolation: isolate;
  width: auto;
  margin: -1rem 1.375rem 0;
  padding: 1.25rem 0.5rem 0.25rem;
  gap: 0.25rem;
  /* The pull request and branch sit at the drawer's right end at every width. An auto margin
     would read as used width to T3, which then hides the drawer's labels. */
  justify-content: space-between;
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border: 1px solid var(--chat-composer-outline);
    border-radius: 0 0 var(--radius-2xl) var(--radius-2xl);
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
    /* The top 15px sit under the card. */
    mask-image: linear-gradient(transparent 15px, black 15px);
  }
  & [data-composer-context-control][aria-label^="Permissions"] {
    display: none;
  }
  & button:is([data-composer-context-control], [data-slot="combobox-trigger"])::after {
    content: "";
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    background-color: currentColor;
    mask: ${chevron} center / contain no-repeat;
  }
  /* The branch picker's icons sat 2px into its padding. */
  & [data-slot="combobox-trigger"] {
    & > svg,
    &::after {
      margin-inline: -0.125rem;
    }
  }
}
`;

/**
 * How far the row has folded as it narrows: every label, then permissions as an icon, then effort
 * too, then T3's own row, which folds them into its menu.
 */
const FOLDS = ["full", "access-icon", "icons", "menu"] as const;
type Fold = (typeof FOLDS)[number];

/** The classic row: pickers on the left, attach and send on the right. */
function ClassicRow({ pieces }: { readonly pieces: WebPluginParts["composer.controls"] }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [fold, setFold] = useState<Fold>("full");
  // The row width each fold needed when it last overflowed, so the row unfolds only once it fits.
  const needed = useRef<Partial<Record<Fold, number>>>({});

  useLayoutEffect(() => {
    if (!row) return;
    const pickers = row.querySelector<HTMLElement>(".classic-composer-pickers");
    const index = FOLDS.indexOf(fold);
    const measure = () => {
      const width = row.clientWidth;
      const overflow = pickers ? pickers.scrollWidth - pickers.clientWidth : 0;
      const tighter = FOLDS[index + 1];
      if (overflow > 0.5 && tighter) {
        needed.current[fold] = width + overflow;
        setFold(tighter);
        return;
      }
      const looser = FOLDS[index - 1];
      if (looser && (needed.current[looser] ?? Number.POSITIVE_INFINITY) <= width) {
        setFold(looser);
      }
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(row);
      for (const picker of pickers?.querySelectorAll("button") ?? []) resize.observe(picker);
    };
    observe();
    const mutations = new MutationObserver(observe);
    if (pickers) mutations.observe(pickers, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [row, fold]);

  return (
    <div ref={setRow} className="classic-composer" data-fold={fold}>
      {fold === "menu" ? (
        <div className="classic-composer-folded">{pieces.original}</div>
      ) : (
        <>
          <div className="classic-composer-pickers">
            {pieces.model}
            <span className="classic-composer-effort">{pieces.effort}</span>
            <span className="classic-composer-access">{pieces.access}</span>
          </div>
          <div className="classic-composer-send">
            {pieces.buttons}
            {pieces.attach}
            {pieces.actions}
          </div>
        </>
      )}
    </div>
  );
}

const COLLAPSE_KEY = "classic-composer:collapse-on-scroll";

/** Whether the composer folds while the timeline is scrolled up. On until turned off here. */
const collapseOnScroll = () => localStorage.getItem(COLLAPSE_KEY) !== "off";

function CollapseSetting(props: { readonly onChange: (on: boolean) => void }) {
  const [on, setOn] = useState(collapseOnScroll);
  return (
    <div className="classic-composer-setting">
      <div>
        <p>Collapse composer on scroll</p>
        <p>
          Rests an existing thread's composer as one line while you scroll up the conversation.
          Focus it or scroll back to the end to expand it again.
        </p>
      </div>
      <Switch
        aria-label="Collapse composer on scroll"
        checked={on}
        onCheckedChange={(checked) => {
          setOn(checked);
          props.onChange(checked);
        }}
      />
    </div>
  );
}

export default defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.composer.setCollapseOnScroll(collapseOnScroll());
    api.settings.registerPanel(() => (
      <CollapseSetting
        onChange={(on) => {
          localStorage.setItem(COLLAPSE_KEY, on ? "on" : "off");
          api.composer.setCollapseOnScroll(on);
        }}
      />
    ));
    api.ui.replace("composer.controls", (pieces) => <ClassicRow pieces={pieces} />);
  },
});
