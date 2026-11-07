import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: ((environmentId: string) => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: environmentId.endsWith(":relay")
      ? { _tag: "Dpop", accessToken: "relay-token" }
      : { _tag: "Bearer", token: "token" },
  })) as never,
}));
const { live } = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    live: Atom.make<AsyncResult.AsyncResult<{ readonly plugins: ReadonlyArray<PluginState> }>>(
      AsyncResult.initial(),
    ),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: {
    pluginsLive: () => live,
    pluginFileHeaders: {
      label: "plugin-file-headers",
      run: async (_registry: unknown, input: { readonly url: string }) =>
        AsyncResult.success({ authorization: "DPoP relay-token", dpop: `proof for ${input.url}` }),
    },
  } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPluginStyles } from "./pluginStyles";

const stylesPlugin = (overrides: Partial<PluginState> = {}): PluginState => ({
  id: PluginId.make("styles-plugin"),
  name: "styles-plugin",
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
  ...overrides,
});

describe("startPluginStyles", () => {
  it("adds an active plugin's stylesheets in order, swaps changed ones and removes them when it is off", async () => {
    // Each sheet names the file and revision it was fetched as.
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(`/* ${url.pathname.split("/").pop()} ${url.searchParams.get("v")} */`);
    });
    const environmentId = EnvironmentId.make("environment:plugin-styles");
    const active = stylesPlugin({
      styles: [
        { file: "base.css", revision: "r1" },
        { file: "compact.css", revision: "r2" },
      ],
    });
    const sheets = () =>
      Array.from(document.querySelectorAll('style[data-plugin="styles-plugin"]'), (sheet) =>
        sheet.textContent?.trim(),
      );
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [active] }));
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
      live,
      AsyncResult.success({
        plugins: [
          {
            ...active,
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
      live,
      AsyncResult.success({ plugins: [stylesPlugin({ enabled: false, status: "disabled" })] }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual([]));

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [active] }));
    await vi.waitFor(() => expect(sheets()).toHaveLength(2));
    stop();
    expect(sheets()).toEqual([]);
  });

  it("signs stylesheet requests with a DPoP proof over a T3 Connect link", async () => {
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("/* relay */"));
    const environmentId = EnvironmentId.make("environment:plugin-styles:relay");
    appAtomRegistry.set(
      live,
      AsyncResult.success({
        plugins: [stylesPlugin({ styles: [{ file: "base.css", revision: "r1" }] })],
      }),
    );
    const stop = startPluginStyles(environmentId);
    using _styles = { [Symbol.dispose]: stop };

    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
        headers: {
          authorization: "DPoP relay-token",
          dpop: "proof for http://plugins.test/api/plugins/styles-plugin/styles/base.css?v=r1",
        },
      }),
    );
  });
});
