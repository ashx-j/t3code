import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { PluginReplaceable } from "./PluginReplaceable";
import {
  pluginContributionKey,
  pluginReplacementAtoms,
  pluginWebFailureAtom,
  registerPluginReplacement,
} from "./pluginRegistry";

const original = <p>T3 controls</p>;
const owner = {
  environmentId: EnvironmentId.make("environment:parts"),
  pluginId: "restyle",
  pluginName: "Restyle",
};

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
      [Symbol.dispose]: registerPluginReplacement(
        "composer.controls",
        (pieces) => (
          <p>
            First: {pieces.model}
            {pieces.actions}
          </p>
        ),
        owner,
      ),
    };
    const unregisterSecond = registerPluginReplacement(
      "composer.controls",
      (pieces) => <p>Second: {pieces.attach}</p>,
      owner,
    );
    using _second = { [Symbol.dispose]: unregisterSecond };
    await using _screen = await render(controls());

    await expect.element(page.getByText("Second: Attach")).toBeVisible();
    unregisterSecond();
    await expect.element(page.getByText("First: ModelSend")).toBeVisible();
    // Another plugin loading later doesn't take over: the id that sorts first keeps the part.
    using _later = {
      [Symbol.dispose]: registerPluginReplacement("composer.controls", () => <p>Later plugin</p>, {
        ...owner,
        pluginId: "zz-later",
      }),
    };
    expect(appAtomRegistry.get(pluginReplacementAtoms["composer.controls"])?.owner.pluginId).toBe(
      "restyle",
    );
  });

  it("draws T3's own part when the replacement throws, and says so on the plugin's row", async () => {
    using _replacement = {
      [Symbol.dispose]: registerPluginReplacement(
        "composer.controls",
        () => {
          throw new Error("boom");
        },
        owner,
      ),
    };
    await using _screen = await render(controls());

    await expect.element(page.getByText("T3 controls")).toBeVisible();
    expect(
      appAtomRegistry.get(
        pluginWebFailureAtom(pluginContributionKey(owner.environmentId, owner.pluginId)),
      ),
    ).toContain("(composer.controls) stopped with an error: boom");
  });
});
