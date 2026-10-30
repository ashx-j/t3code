import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
      name: "hello",
      title: "Hello panel",
      component: (props) => <p>Panel for {props.threadId}</p>,
    });
    using _panel = { [Symbol.dispose]: unregister };
    const onClose = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <PluginPanelSurface
          environmentId={environmentId}
          threadId="thread-1"
          pluginId="hello-web"
          panel="hello"
          onClose={onClose}
        />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Panel for thread-1")).toBeVisible();
    unregister();
    await expect.element(page.getByText("Plugin not active")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
