import { Switch } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";
import { useState } from "react";

// Built to web.js by `vp build --config examples/classic-composer/vite.config.ts` from
// packages/plugin-sdk.

// The stylesheet only reaches the plugin's own elements. The old row sat 16px in from the card's
// right and bottom edges, and 12px in a narrow composer with the model picker pulled 4px toward
// the edge. T3 already insets the row by 8px.
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
.classic-composer-send {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  margin-inline: 0.5rem 0.25rem;
  margin-block-end: 0.25rem;
}
@container classic-composer (min-width: 28rem) {
  .classic-composer-pickers {
    margin-inline-start: 0;
    margin-block-end: 0.5rem;
  }
  .classic-composer-send {
    margin-inline-end: 0.5rem;
    margin-block-end: 0.5rem;
  }
}

.classic-composer-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  & p {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 500;
  }
  & p + p {
    font-weight: 400;
    margin-top: 0.125rem;
    font-size: 0.75rem;
    opacity: 0.7;
  }
}
`;

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
    api.ui.replace("composer.controls", (pieces) => (
      <div className="classic-composer">
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
      </div>
    ));
  },
});
