import { defineWebPlugin } from "@t3tools/plugin-sdk/web";

// Built to web.js by `vp build --config examples/review-flags/vite.config.ts` from
// packages/plugin-sdk.
function FlagIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
    </svg>
  );
}

export default defineWebPlugin({
  activate(api) {
    // Flags live in memory, so they clear when the app reloads.
    const flag = (threadId: string) => {
      api.threads.setBadge(threadId, { label: "Review", tone: "warning" });
    };
    api.messages.addAction({
      id: "flag",
      title: "Flag this thread for review",
      icon: FlagIcon,
      run: (message) => {
        flag(message.threadId);
        api.toast({ title: "Flagged for review", description: `From a ${message.role} message.` });
      },
    });
    api.threads.addHeaderButton({
      id: "flag",
      title: "Flag for review",
      icon: FlagIcon,
      run: (thread) => flag(thread.threadId),
    });
    api.composer.addButton({
      id: "flag",
      title: "Flag this thread for review",
      icon: FlagIcon,
      run: (target) => {
        if (target.threadId === null) {
          api.toast({ title: "Send a message first", type: "warning" });
          return;
        }
        flag(target.threadId);
      },
    });
    api.threads.addMenuItem({
      id: "clear",
      title: "Clear review flag",
      run: (thread) => api.threads.setBadge(thread.threadId, null),
    });
  },
});
