import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: { _tag: "Bearer", token: "token" },
  })) as never,
}));
const state = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    live: Atom.make<AsyncResult.AsyncResult<{ readonly plugins: ReadonlyArray<PluginState> }>>(
      AsyncResult.initial(),
    ),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: { pluginsLive: () => state.live } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPluginStyles } from "./pluginStyles";

const stylesPluginState: PluginState = {
  id: PluginId.make("styles-plugin"),
  name: "styles-plugin",
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
};

describe("startPluginStyles", () => {
  it("adds an active plugin's stylesheets in order, swaps changed ones and removes them when it is off", async () => {
    // Each sheet names the file and revision it was fetched as.
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(`/* ${url.pathname.split("/").pop()} ${url.searchParams.get("v")} */`);
    });
    const environmentId = EnvironmentId.make("environment:plugin-styles");
    const stylesPlugin: PluginState = {
      ...stylesPluginState,
      styles: [
        { file: "base.css", revision: "r1" },
        { file: "compact.css", revision: "r2" },
      ],
    };
    const sheets = () =>
      Array.from(document.querySelectorAll('style[data-plugin="styles-plugin"]'), (sheet) =>
        sheet.textContent?.trim(),
      );
    appAtomRegistry.set(state.live, AsyncResult.success({ plugins: [stylesPlugin] }));
    const stop = startPluginStyles(environmentId);
    using _styles = { [Symbol.dispose]: stop };

    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r2 */"]));
    // After the app's own styles, so a rule of the same specificity wins.
    expect(document.head.lastElementChild?.textContent).toBe("/* compact.css r2 */");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "http://plugins.test/api/plugins/styles-plugin/styles/base.css?v=r1",
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });

    appAtomRegistry.set(
      state.live,
      AsyncResult.success({
        plugins: [
          {
            ...stylesPlugin,
            styles: [
              { file: "base.css", revision: "r1" },
              { file: "compact.css", revision: "r3" },
            ],
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r3 */"]));

    appAtomRegistry.set(
      state.live,
      AsyncResult.success({
        plugins: [{ ...stylesPluginState, enabled: false, status: "disabled" }],
      }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual([]));

    appAtomRegistry.set(state.live, AsyncResult.success({ plugins: [stylesPlugin] }));
    await vi.waitFor(() => expect(sheets()).toHaveLength(2));
    stop();
    expect(sheets()).toEqual([]);
  });
});
