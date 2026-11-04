import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/message-extras/vite.config.ts` from
// packages/plugin-sdk.
const css = `
.message-extras-count { margin-top: 0.25rem; font-size: 0.6875rem; color: var(--muted-foreground); }
.message-extras-terminal {
  margin: 0;
  max-height: 20rem;
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--terminal-background);
  padding: 0.5rem 0.75rem;
  color: var(--terminal-foreground);
  font: 0.75rem/1.5 var(--font-mono, monospace);
  white-space: pre-wrap;
}
.message-extras-terminal pre { margin: 0; font: inherit; white-space: pre-wrap; }
.message-extras-terminal b { color: var(--success-foreground); font-weight: 400; }
.message-extras-diff { display: flex; min-height: 0; flex: 1; flex-direction: column; }
.message-extras-diff-summary { padding: 0.25rem 0.75rem; font-size: 0.6875rem; color: var(--muted-foreground); }
`;

// Counts files and added and removed lines in a unified diff.
const summarizePatch = (patch: string) => {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) files += 1;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed += 1;
  }
  return `${files} ${files === 1 ? "file" : "files"}, +${added} -${removed}`;
};

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
    api.ui.replace("diff.view", (diff) => (
      <div className="message-extras-diff">
        {diff.patch ? (
          <p className="message-extras-diff-summary">{summarizePatch(diff.patch)}</p>
        ) : null}
        {diff.original}
      </div>
    ));
    api.ui.replace("timeline.item", (step) =>
      step.item.type === "command_execution" && typeof step.item.input === "string" ? (
        <div className="message-extras-terminal">
          <pre>
            <b>$ {step.item.input}</b>
            {step.output ? `\n${step.output}` : null}
          </pre>
          {step.commandOutput}
        </div>
      ) : (
        step.original
      ),
    );
  },
});
