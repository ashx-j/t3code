import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { PluginPanelSurface } from "./PluginPanelSurface";
import { registerPluginRightPanel } from "./pluginRegistry";

describe("PluginPanelSurface", () => {
  it("renders a plugin's panel, then a notice with a way out once the plugin unloads", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-panel");
    const unregister = registerPluginRightPanel({
      environmentId,
      pluginId: "hello-web",
      owner: { environmentId, pluginId: "hello-web", pluginName: "Hello web" },
      name: "hello",
      title: "Hello panel",
      component: (props) => <p>Panel for {props.threadId}</p>,
    });
    using _panel = { [Symbol.dispose]: unregister };
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <PluginPanelSurface
          environmentId={environmentId}
          threadId="thread-1"
          pluginId="hello-web"
          panel="hello"
          onClose={() => {}}
        />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Panel for thread-1")).toBeVisible();
    unregister();
    await expect.element(page.getByText("Plugin not active")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close" })).toBeVisible();
  });
});
