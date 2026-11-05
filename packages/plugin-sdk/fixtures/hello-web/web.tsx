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
        <div className="hello-web-panel">
          <p>{greeting}</p>
          <p>{note}</p>
          <p className="hello-web-muted">Thread {props.threadId}</p>
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
          <div className="hello-web-chart">
            {bars.map((bar) => (
              <div key={bar.id} className="hello-web-bar" style={{ height: `${bar.height}%` }} />
            ))}
          </div>
        );
      },
    });
    api.timeline.registerToolRenderer({
      tool: "greet",
      component: (props) => <p className="hello-web-text">👋 {props.output ?? "Greeting…"}</p>,
    });
    // Its own classes: T3's Tailwind classes exist only while T3's own code happens to use them.
    api.injectStyles(`
.hello-web-panel { display: grid; gap: 0.25rem; padding: 1rem; font-size: 0.875rem; border-top: 2px solid var(--primary); }
.hello-web-muted { color: var(--muted-foreground); }
.hello-web-text { font-size: 0.875rem; }
.hello-web-chart { display: flex; height: 4rem; align-items: flex-end; gap: 0.25rem; }
.hello-web-bar { width: 0.75rem; background: var(--primary); }
.hello-web-settings { display: grid; gap: 0.5rem; }
.hello-web-settings p { font-size: 0.75rem; }
`);
    api.composer.setCollapseOnScroll(true);
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
      desktop: { menu: true, tray: true },
      run: () => api.navigate("/settings/plugins"),
    });
    api.settings.registerPanel(() => (
      <div className="hello-web-settings">
        <p>These settings are drawn by hello-web.</p>
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
