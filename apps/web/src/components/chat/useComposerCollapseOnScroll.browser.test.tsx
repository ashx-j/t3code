import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { setPluginComposerCollapseOnScroll } from "../../plugins/pluginRegistry";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useComposerCollapseOnScroll } from "./useComposerCollapseOnScroll";
import { timelineAwayFromEndAtom } from "./useTimelineFollow";

const threadRef = scopeThreadRef(EnvironmentId.make("environment:fold"), ThreadId.make("thread"));
const awayFromEnd = timelineAwayFromEndAtom(scopedThreadKey(threadRef));

function Composer({ wideScreen }: { wideScreen: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const fold = useComposerCollapseOnScroll({ wideScreen, threadRef, formRef });
  return (
    <form ref={formRef}>
      <input aria-label="Message" />
      <p>{fold.awayFromEnd ? "Folded" : "Open"}</p>
    </form>
  );
}

describe("useComposerCollapseOnScroll", () => {
  it("folds a focused composer when the timeline leaves its end, on wide screens only", async () => {
    setPluginComposerCollapseOnScroll("test-plugin", true);
    using _request = {
      [Symbol.dispose]: () => setPluginComposerCollapseOnScroll("test-plugin", false),
    };
    using _away = { [Symbol.dispose]: () => appAtomRegistry.set(awayFromEnd, false) };
    await using screen = await render(
      <AppAtomRegistryProvider>
        <Composer wideScreen />
      </AppAtomRegistryProvider>,
    );
    const message = page.getByRole("textbox", { name: "Message" });
    await userEvent.click(message);

    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Folded")).toBeVisible();
    expect(document.activeElement).not.toBe(message.element());

    appAtomRegistry.set(awayFromEnd, false);
    await expect.element(page.getByText("Open")).toBeVisible();

    // Phones fold on their own when the composer loses focus.
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Composer wideScreen={false} />
      </AppAtomRegistryProvider>,
    );
    appAtomRegistry.set(awayFromEnd, true);
    await expect.element(page.getByText("Open")).toBeVisible();
  });
});
