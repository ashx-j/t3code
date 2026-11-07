// @effect-diagnostics globalFetch:off
// Written by hand in the shape `t3PluginWeb` builds, so tests load it with no build step: React and
// the UI kit come from T3 through `globalThis.__t3PluginHost`.

/** @type {{ readonly react: typeof import("react"); readonly ui: typeof import("@t3tools/plugin-sdk/ui") }} */
const host = Reflect.get(globalThis, "__t3PluginHost");
const { createElement: h, useEffect, useState } = host.react;
const { Button } = host.ui;

/** @type {import("@t3tools/plugin-sdk/web").WebPluginDefinition} */
export default {
  activate(api) {
    /** @param {{ readonly threadId: string }} props */
    function HelloPanel(props) {
      const [greeting, setGreeting] = useState("Loading…");
      const [note, setNote] = useState("");
      useEffect(() => {
        void api.rpc.invoke("greeting").then((value) => setGreeting(String(value)));
        void api
          .assetUrl("hello.txt")
          .then((url) => fetch(url))
          .then((response) => response.text())
          .then(setNote);
      }, []);
      return h(
        "div",
        { className: "hello-web-panel" },
        h("p", null, greeting),
        h("p", null, note),
        h("p", { className: "hello-web-muted" }, "Thread ", props.threadId),
      );
    }
    // Its own classes: T3's Tailwind classes exist only while T3's own code happens to use them.
    api.injectStyles(`
.hello-web-panel { display: grid; gap: 0.25rem; padding: 1rem; font-size: 0.875rem; border-top: 2px solid var(--primary); }
.hello-web-muted { color: var(--muted-foreground); }
.hello-web-settings { display: grid; gap: 0.5rem; }
.hello-web-settings p { font-size: 0.75rem; }
`);
    api.rightPanel.register({ name: "hello", title: "Hello panel", component: HelloPanel });
    api.commands.register({
      id: "open-settings",
      title: "Open hello-web settings",
      keywords: ["hello"],
      run: () => api.navigate("/settings/plugins"),
    });
    api.settings.registerPanel(() =>
      h(
        "div",
        { className: "hello-web-settings" },
        h("p", null, "These settings are drawn by hello-web."),
        h(
          Button,
          {
            size: "xs",
            variant: "outline",
            onClick: () => api.toast({ title: "Hello from hello-web" }),
          },
          "Say hello",
        ),
      ),
    );
  },
};
