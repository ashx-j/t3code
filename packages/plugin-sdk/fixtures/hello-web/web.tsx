// @effect-diagnostics globalFetch:off
import { Button } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";
import { useEffect, useState } from "react";

// Built to web.js by `vp build --config fixtures/hello-web/vite.config.ts` from packages/plugin-sdk.
export default defineWebPlugin({
  activate(api) {
    function HelloPanel(props: { readonly threadId: string }) {
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
      return (
        <div className="hello-web-panel space-y-1 p-4 text-sm">
          <p>{greeting}</p>
          <p>{note}</p>
          <p className="text-muted-foreground">Thread {props.threadId}</p>
        </div>
      );
    }
    api.markdown.registerCodeBlock({
      language: "hello-chart",
      component: (props) => {
        const bars = props.code
          .split(",")
          .map((value, position) => ({ id: `bar-${position}`, height: Number(value) * 10 }));
        return (
          <div className="flex h-16 items-end gap-1">
            {bars.map((bar) => (
              <div key={bar.id} className="w-3 bg-primary" style={{ height: `${bar.height}%` }} />
            ))}
          </div>
        );
      },
    });
    api.timeline.registerToolRenderer({
      tool: "greet",
      component: (props) => <p className="text-sm">👋 {props.output ?? "Greeting…"}</p>,
    });
    api.injectStyles(".hello-web-panel { border-top: 2px solid var(--color-primary); }");
    api.rightPanel.register({ name: "hello", title: "Hello panel", component: HelloPanel });
    api.composer.registerSlashCommand({
      name: "hello",
      description: "Say hello from hello-web",
      run: ({ threadId }) => {
        api.composer.showBanner({
          title: "Hello from hello-web",
          description: `Thread ${threadId}`,
        });
      },
    });
    api.commands.register({
      id: "open-settings",
      title: "Open hello-web settings",
      keywords: ["hello"],
      run: () => api.navigate("/settings/plugins"),
    });
    api.settings.registerPanel(() => (
      <div className="space-y-2">
        <p className="text-xs">These settings are drawn by hello-web.</p>
        <Button
          size="xs"
          variant="outline"
          onClick={() => api.toast({ title: "Hello from hello-web" })}
        >
          Say hello
        </Button>
      </div>
    ));
  },
});
