// Written by hand in the shape `t3PluginWeb` builds, so tests load it with no build step: React
// comes from T3 through `globalThis.__t3PluginHost`.

/** @type {{ readonly react: typeof import("react") }} */
const host = Reflect.get(globalThis, "__t3PluginHost");
const { createElement: h, useEffect, useState } = host.react;

/** @type {import("@t3tools/plugin-sdk/web").WebPluginDefinition} */
export default {
  activate(api) {
    /** @param {{ readonly threadId: string }} props */
    function HelloPanel(props) {
      const [greeting, setGreeting] = useState("Loading…");
      useEffect(() => {
        void api.rpc.invoke("greeting").then((value) => setGreeting(String(value)));
      }, []);
      return h(
        "div",
        { className: "hello-web-panel" },
        h("p", null, greeting),
        h("p", { className: "hello-web-muted" }, "Thread ", props.threadId),
      );
    }
    // Its own classes: T3's Tailwind classes exist only while T3's own code happens to use them.
    api.injectStyles(`
.hello-web-panel { display: grid; gap: 0.25rem; padding: 1rem; font-size: 0.875rem; border-top: 2px solid var(--primary); }
.hello-web-muted { color: var(--muted-foreground); }
`);
    api.rightPanel.register({ name: "hello", title: "Hello panel", component: HelloPanel });
  },
};
