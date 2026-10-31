import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { registerPluginReplacement } from "../plugins/pluginRegistry";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { AppRouteModal, AppRouteModalClose } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("shows a plugin's page frame without a dialog, and Esc commits a focused field there too", async () => {
    using _frame = {
      [Symbol.dispose]: registerPluginReplacement("app.pageFrame", (frame) => frame.page),
    };
    const onCommit = vi.fn();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <AppRouteModal label="Settings">
          <CommitOnBlurField onCommit={onCommit} />
          <AppRouteModalClose />
        </AppRouteModal>
      </AppAtomRegistryProvider>,
      { router: "/settings/general" },
    );

    await expect.element(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });
});
