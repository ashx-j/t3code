import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { PluginReplaceable } from "./PluginReplaceable";
import { registerPluginReplacement } from "./pluginRegistry";

const original = <p>T3 controls</p>;

const controls = () => (
  <AppAtomRegistryProvider>
    <PluginReplaceable
      part="composer.controls"
      pieces={{
        original,
        attach: <span>Attach</span>,
        controls: null,
        model: <span>Model</span>,
        effort: null,
        access: null,
        actions: <span>Send</span>,
        buttons: null,
      }}
    />
  </AppAtomRegistryProvider>
);

describe("PluginReplaceable", () => {
  it("draws the newest replacement and brings back the previous one when it unloads", async () => {
    using _first = {
      [Symbol.dispose]: registerPluginReplacement("composer.controls", (pieces) => (
        <p>
          First: {pieces.model}
          {pieces.actions}
        </p>
      )),
    };
    const unregisterSecond = registerPluginReplacement("composer.controls", (pieces) => (
      <p>Second: {pieces.attach}</p>
    ));
    using _second = { [Symbol.dispose]: unregisterSecond };
    await using _screen = await render(controls());

    await expect.element(page.getByText("Second: Attach")).toBeVisible();
    unregisterSecond();
    await expect.element(page.getByText("First: ModelSend")).toBeVisible();
  });

  it("draws T3's own part when the replacement throws", async () => {
    using _replacement = {
      [Symbol.dispose]: registerPluginReplacement("composer.controls", () => {
        throw new Error("boom");
      }),
    };
    await using _screen = await render(controls());

    await expect.element(page.getByText("T3 controls")).toBeVisible();
  });
});
