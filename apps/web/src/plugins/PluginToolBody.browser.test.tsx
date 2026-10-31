import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { PluginToolBody } from "./PluginToolBody";
import { registerPluginToolRenderer } from "./pluginRegistry";

const environmentId = EnvironmentId.make("environment:plugin-tool");

const body = (toolName: string) => (
  <AppAtomRegistryProvider>
    <PluginToolBody
      environmentId={environmentId}
      toolName={toolName}
      input={{ text: "hi" }}
      output="hi"
      status="completed"
      fallback={<p>Generic tool view</p>}
    />
  </AppAtomRegistryProvider>
);

describe("PluginToolBody", () => {
  it("draws a plugin tool call with its renderer until the plugin unloads", async () => {
    const unregister = registerPluginToolRenderer({
      environmentId,
      toolName: "plg_hello-web_echo",
      component: (props) => <p>Echoed {props.output}</p>,
    });
    using _renderer = { [Symbol.dispose]: unregister };
    await using screen = await render(body("plg_hello-web_echo"));

    await expect.element(page.getByText("Echoed hi")).toBeVisible();
    // Claude reports MCP tools with its server prefix.
    await screen.rerender(body("mcp__t3-code__plg_hello-web_echo"));
    await expect.element(page.getByText("Echoed hi")).toBeVisible();
    unregister();
    await expect.element(page.getByText("Generic tool view")).toBeVisible();
  });

  it("falls back to the generic view when the renderer throws", async () => {
    using _renderer = {
      [Symbol.dispose]: registerPluginToolRenderer({
        environmentId,
        toolName: "plg_hello-web_fail",
        component: () => {
          throw new Error("boom");
        },
      }),
    };
    await using _screen = await render(body("plg_hello-web_fail"));

    await expect.element(page.getByText("Generic tool view")).toBeVisible();
  });
});
