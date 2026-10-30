// \0t3-plugin-host:@t3tools/plugin-sdk/ui
var host$2 = globalThis.__t3PluginHost.ui;
var read$2 = (name) => host$2[name];
var Button = /* @__PURE__ */ read$2("Button");
// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react
var host$1 = globalThis.__t3PluginHost.react;
var read$1 = (name) => host$1[name];
var useEffect = /* @__PURE__ */ read$1("useEffect");
var useState = /* @__PURE__ */ read$1("useState");
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// fixtures/hello-web/web.tsx
var web_default = defineWebPlugin({
  activate(api) {
    function HelloPanel(props) {
      const [greeting, setGreeting] = useState("Loading…");
      const [note, setNote] = useState("");
      useEffect(() => {
        api.rpc.invoke("greeting").then((value) => setGreeting(String(value)));
        api
          .assetUrl("hello.txt")
          .then((url) => fetch(url))
          .then((response) => response.text())
          .then(setNote);
      }, []);
      return /* @__PURE__ */ jsxs("div", {
        className: "space-y-1 p-4 text-sm",
        children: [
          /* @__PURE__ */ jsx("p", { children: greeting }),
          /* @__PURE__ */ jsx("p", { children: note }),
          /* @__PURE__ */ jsxs("p", {
            className: "text-muted-foreground",
            children: ["Thread ", props.threadId],
          }),
        ],
      });
    }
    api.rightPanel.register({
      name: "hello",
      title: "Hello panel",
      component: HelloPanel,
    });
    api.composer.registerSlashCommand({
      name: "hello",
      description: "Say hello from hello-web",
      run: ({ threadId }) =>
        api.toast({
          title: "Hello",
          description: `From thread ${threadId}`,
        }),
    });
    api.commands.register({
      id: "open-settings",
      title: "Open hello-web settings",
      keywords: ["hello"],
      run: () => api.navigate("/settings/plugins"),
    });
    api.settings.registerPanel(() =>
      /* @__PURE__ */ jsxs("div", {
        className: "space-y-2",
        children: [
          /* @__PURE__ */ jsx("p", {
            className: "text-xs",
            children: "These settings are drawn by hello-web.",
          }),
          /* @__PURE__ */ jsx(Button, {
            size: "xs",
            variant: "outline",
            onClick: () => api.toast({ title: "Hello from hello-web" }),
            children: "Say hello",
          }),
        ],
      }),
    );
  },
});
export { web_default as default };
