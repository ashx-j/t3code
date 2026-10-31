import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/message-extras/vite.config.ts` from
// packages/plugin-sdk.
const css = `
.message-extras-count { margin-top: 0.25rem; font-size: 0.6875rem; color: var(--muted-foreground); }
.message-extras-terminal {
  margin: 0;
  max-height: 20rem;
  overflow: auto;
  border-radius: 0.375rem;
  background: #0c0c0c;
  padding: 0.5rem 0.75rem;
  color: #d4d4d4;
  font: 0.75rem/1.5 var(--font-mono, monospace);
  white-space: pre-wrap;
}
.message-extras-terminal b { color: #7ee787; font-weight: 400; }
`;

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

export default defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    api.ui.replace("message.assistant", (message) => (
      <>
        {message.original}
        {message.streaming ? null : (
          <p className="message-extras-count">{countWords(message.text)} words</p>
        )}
      </>
    ));
    api.ui.replace("timeline.item", (step) =>
      step.item.type === "command_execution" && typeof step.item.input === "string" ? (
        <pre className="message-extras-terminal">
          <b>$ {step.item.input}</b>
          {step.output ? `\n${step.output}` : null}
        </pre>
      ) : (
        step.original
      ),
    );
  },
});
