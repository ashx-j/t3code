// \0t3-plugin-host:@t3tools/plugin-sdk/ui
var host$2 = globalThis.__t3PluginHost.ui;
var read$2 = (name) => host$2[name];
var Switch = /* @__PURE__ */ read$2("Switch");
// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react
var host$1 = globalThis.__t3PluginHost.react;
var read$1 = (name) => host$1[name];
var useLayoutEffect = /* @__PURE__ */ read$1("useLayoutEffect");
var useRef = /* @__PURE__ */ read$1("useRef");
var useState = /* @__PURE__ */ read$1("useState");
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var Fragment = /* @__PURE__ */ read("Fragment");
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/classic-composer/web.tsx
var chevronSvg = (stroke) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='${stroke}' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
var chevron = chevronSvg(2.25);
var drawerChevron = chevronSvg(1.75);
var lockOpen = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 9.9-1'/%3E%3C/svg%3E")`;
var drawerInset = "var(--chat-composer-drawer-inset, 1.375rem)";
var cardRadius = "var(--radius-2xl, calc(var(--radius) + 8px))";
var css = `
.classic-composer {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
}
.classic-composer-pickers {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  margin-inline-start: -0.25rem;
  margin-block-end: 0.25rem;
}
.classic-composer-effort {
  display: contents;
}
/* Permissions and the plan toggle sit 4px apart, as one block like T3's own row. */
.classic-composer-access {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.25rem;
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
@media (width >= 40rem) {
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
    font-size: var(--text-sm, 0.875rem);
    font-weight: 500;
  }
  & p + p {
    margin-top: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs, 0.75rem);
    font-weight: 400;
  }
}

/* --- Rules that reach into T3's markup. T3 has no seam for these yet; the README lists each one
   with the seam that would replace it. Each matches a hook T3 sets for its own code, so when one
   is renamed the rule stops matching and T3's own look shows. --- */

/* 1. Hook: data-chat-composer-actions and data-chat-composer-controls, which T3's composer reads.
      A narrow row hands over to T3's own row, the only one that folds pickers into a menu, and
      puts the pickers back on the left, with the menu button against the model like the old
      row's. The context meter and send keep the 8px the actions box put between them. */
.classic-composer-folded {
  & [data-chat-composer-actions="right"] {
    display: contents;
    & > :not([data-chat-composer-controls="footer"]) + * {
      margin-inline-start: 0.5rem;
    }
  }
  & [data-chat-composer-controls="footer"] {
    order: -1;
    justify-content: flex-start;
    gap: 0;
    margin-inline: -0.25rem 0.5rem;
  }
}
@media (width >= 40rem) {
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
      drawer tucked under the card, with chevrons. */
[data-slot="composer-context-strip"] {
  isolation: isolate;
  width: auto;
  margin: -1rem ${drawerInset} 0;
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
    border: 1px solid var(--chat-composer-outline, var(--border));
    border-radius: 0 0 ${cardRadius} ${cardRadius};
    background-color: var(--chat-composer-glass-surface, var(--card));
    /* The top 15px sit under the card. */
    mask-image: linear-gradient(transparent 15px, black 15px);
  }
  & button:is([data-composer-context-control], [data-slot="combobox-trigger"])::after {
    content: "";
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    background-color: currentColor;
    mask: ${drawerChevron} center / contain no-repeat;
  }
  /* The branch picker's icons sat 2px into its padding. */
  & [data-slot="combobox-trigger"] {
    & > svg,
    &::after {
      margin-inline: -0.125rem;
    }
  }
}
/* In dark, the drawer is glass like the card, the card casts a shadow onto it, and it has a faint
   white fill. In light it is solid. */
.dark [data-slot="composer-context-strip"]::before {
  background-color: color-mix(
    in oklab,
    var(--chat-composer-glass-surface, var(--card)) var(--glass-opacity, 100%),
    transparent
  );
  -webkit-backdrop-filter: blur(var(--glass-blur, 0)) saturate(var(--glass-saturation, 1));
  backdrop-filter: blur(var(--glass-blur, 0)) saturate(var(--glass-saturation, 1));
  background-image:
    linear-gradient(transparent 16px, rgb(0 0 0 / 18%) 16px, transparent 26px),
    linear-gradient(rgb(255 255 255 / 1%), rgb(255 255 255 / 1%));
  background-origin: border-box;
}
/* While the row shows its own pickers, the drawer doesn't repeat the permissions, and a folder
   without git, which leaves the drawer nothing else, shows no drawer. T3's own row, which the
   narrowest composer hands over to, leaves the permissions to the drawer. The strip's permissions
   chip is marked only by its label. */
[data-slot="composer-shell"]:has(.classic-composer-pickers) [data-slot="composer-context-strip"] {
  & [data-composer-context-control][aria-label^="Permissions"] {
    display: none;
  }
  &:not(:has(> :not([aria-label^="Permissions"]))) {
    display: none;
  }
}
/* The card's outline opens where the drawer joins it, so no hairline crosses the join, and its fill
   lets the drawer's side edges run up into the card's last pixel. Hook: data-context-row, which T3
   sets on the shell while the drawer shows, and the outline and fill on the card's own elements.
   Only while the drawer shows: it holds more than the permissions, or T3's row leaves them there. */
[data-slot="composer-shell"][data-context-row]:is(
    :has([data-slot="composer-context-strip"] > :not([aria-label^="Permissions"])),
    :not(:has(.classic-composer-pickers))
  ) {
  & :is([data-slot="composer-host"], [data-chat-composer-main-surface])::after {
    clip-path: polygon(
      0 0,
      100% 0,
      100% 100%,
      calc(100% - ${drawerInset}) 100%,
      calc(100% - ${drawerInset}) calc(100% - 2px),
      ${drawerInset} calc(100% - 2px),
      ${drawerInset} 100%,
      0 100%
    );
  }
  & [data-slot="composer-host"]::before {
    clip-path: polygon(
      0 0,
      100% 0,
      100% 100%,
      calc(100% - ${drawerInset}) 100%,
      calc(100% - ${drawerInset}) calc(100% - 1px),
      calc(100% - ${drawerInset} - 1px) calc(100% - 1px),
      calc(100% - ${drawerInset} - 1px) 100%,
      calc(${drawerInset} + 1px) 100%,
      calc(${drawerInset} + 1px) calc(100% - 1px),
      ${drawerInset} calc(100% - 1px),
      ${drawerInset} 100%,
      0 100%
    );
  }
}

/* 5. Hook: data-chat-composer-body, which T3's resting animation reads. The prompt sat 12px in on
      a narrow screen, like the row. */
@media (width < 40rem) {
  [data-chat-composer-body] {
    padding-inline: 0.75rem;
  }
}

/* 6. Hook: the Lucide class on the attach icon, inside this plugin's row. The paperclip sat 1px
      higher before T3 nudged it down. */
.classic-composer svg.lucide-paperclip {
  translate: none;
}
`;
/**
 * How far the row has folded as it narrows: every label, then permissions as an icon, then effort
 * too, then T3's own row, which folds them into its menu.
 */
var FOLDS = ["full", "access-icon", "icons", "menu"];
/** The text of the pickers, which changes with the model, effort or permissions picked. */
var pickerLabels = (area) =>
  Array.from(
    area.querySelectorAll("[data-chat-provider-model-picker], [data-composer-shortcut]"),
    (picker) => picker.textContent,
  ).join("\n");
/** The classic row: pickers on the left, attach and send on the right. */
function ClassicRow({ pieces }) {
  const [row, setRow] = useState(null);
  const [fold, setFold] = useState("full");
  const overflows = useRef(/* @__PURE__ */ new Map());
  const needs = useRef(/* @__PURE__ */ new Map());
  useLayoutEffect(() => {
    if (!row) return;
    const pickers = row.querySelector(".classic-composer-pickers");
    const area = pickers ?? row.querySelector('[data-chat-composer-controls="footer"]') ?? row;
    const index = FOLDS.indexOf(fold);
    const measure = () => {
      const room = area.clientWidth;
      const labels = pickerLabels(area);
      const looser = FOLDS[index - 1];
      const lacked = looser ? overflows.current.get(looser) : void 0;
      if (looser && lacked !== void 0 && !needs.current.has(looser))
        needs.current.set(looser, {
          room: room + lacked,
          labels,
        });
      const need = looser ? needs.current.get(looser) : void 0;
      const overflow = pickers ? pickers.scrollWidth - pickers.clientWidth : 0;
      const tighter = FOLDS[index + 1];
      if (overflow > 0.5 && tighter) {
        overflows.current.set(fold, overflow);
        needs.current.delete(fold);
        setFold(tighter);
      } else if (looser && (!need || need.labels !== labels || need.room <= room)) setFold(looser);
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(area);
      for (const picker of pickers?.querySelectorAll("button") ?? []) resize.observe(picker);
    };
    observe();
    measure();
    const mutations = new MutationObserver(() => {
      observe();
      measure();
    });
    mutations.observe(area, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [row, fold]);
  return /* @__PURE__ */ jsx("div", {
    ref: setRow,
    className: "classic-composer",
    "data-fold": fold,
    children:
      fold === "menu"
        ? /* @__PURE__ */ jsx("div", {
            className: "classic-composer-folded",
            children: pieces.original,
          })
        : /* @__PURE__ */ jsxs(Fragment, {
            children: [
              /* @__PURE__ */ jsxs("div", {
                className: "classic-composer-pickers",
                children: [
                  pieces.model,
                  /* @__PURE__ */ jsx("span", {
                    className: "classic-composer-effort",
                    children: pieces.effort,
                  }),
                  /* @__PURE__ */ jsx("span", {
                    className: "classic-composer-access",
                    children: pieces.access,
                  }),
                ],
              }),
              /* @__PURE__ */ jsxs("div", {
                className: "classic-composer-send",
                children: [pieces.attach, pieces.buttons, pieces.actions],
              }),
            ],
          }),
  });
}
var COLLAPSE_KEY = "classic-composer:collapse-on-scroll";
/** Whether the composer folds while the timeline is scrolled up. On until turned off here. */
var collapseOnScroll = () => localStorage.getItem(COLLAPSE_KEY) !== "off";
function CollapseSetting(props) {
  const [on, setOn] = useState(collapseOnScroll);
  return /* @__PURE__ */ jsxs("div", {
    className: "classic-composer-setting",
    children: [
      /* @__PURE__ */ jsxs("div", {
        children: [
          /* @__PURE__ */ jsx("p", { children: "Collapse composer on scroll" }),
          /* @__PURE__ */ jsx("p", {
            children:
              "Rests an existing thread's composer as one line while you scroll up the conversation. Focus it or scroll back to the end to expand it again.",
          }),
        ],
      }),
      /* @__PURE__ */ jsx(Switch, {
        "aria-label": "Collapse composer on scroll",
        checked: on,
        onCheckedChange: (checked) => {
          setOn(checked);
          props.onChange(checked);
        },
      }),
    ],
  });
}
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.composer.setCollapseOnScroll(collapseOnScroll());
    api.settings.registerPanel(() =>
      /* @__PURE__ */ jsx(CollapseSetting, {
        onChange: (on) => {
          localStorage.setItem(COLLAPSE_KEY, on ? "on" : "off");
          api.composer.setCollapseOnScroll(on);
        },
      }),
    );
    api.ui.replace("composer.controls", (pieces) => /* @__PURE__ */ jsx(ClassicRow, { pieces }));
  },
});
export { web_default as default };
