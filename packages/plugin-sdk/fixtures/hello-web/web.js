// Hand-written ESM against the host's shared modules; a real plugin would build this with the SDK.
const host =
  /** @type {{ jsxRuntime: { jsx: (type: unknown, props: object) => unknown, jsxs: (type: unknown, props: object) => unknown }, react: { useEffect: (run: () => void, deps: ReadonlyArray<unknown>) => void, useState: <T>(initial: T) => [T, (next: T) => void] } }} */ (
    Reflect.get(globalThis, "__t3PluginHost")
  );
const { jsx, jsxs } = host.jsxRuntime;
const { useEffect, useState } = host.react;

/** @type {import("@t3tools/plugin-sdk/web").WebPluginDefinition} */
export default {
  activate(api) {
    /** @param {{ threadId: string }} props */
    const HelloPanel = (props) => {
      const [greeting, setGreeting] = useState("Loading…");
      useEffect(() => {
        void api.rpc.invoke("greeting").then((value) => setGreeting(String(value)));
      }, []);
      return jsxs("div", {
        className: "space-y-1 p-4 text-sm",
        children: [
          jsx("p", { children: greeting }),
          jsx("p", { className: "text-muted-foreground", children: `Thread ${props.threadId}` }),
        ],
      });
    };
    api.rightPanel.register({ name: "hello", title: "Hello panel", component: HelloPanel });
    api.settings.registerPanel(() =>
      jsx("p", { className: "text-xs", children: "These settings are drawn by hello-web." }),
    );
  },
};
