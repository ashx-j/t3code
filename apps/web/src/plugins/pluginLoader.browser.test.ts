import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import helloWebSource from "../../../../packages/plugin-sdk/fixtures/hello-web/web.js?raw";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: ((environmentId: string) => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: environmentId.endsWith(":relay")
      ? { _tag: "Dpop", accessToken: "relay-token" }
      : { _tag: "Bearer", token: "token" },
  })) as never,
}));
const reportWebFailure = vi.hoisted(() => vi.fn());
const { live, channel } = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    live: Atom.make<AsyncResult.AsyncResult<{ readonly plugins: ReadonlyArray<PluginState> }>>(
      AsyncResult.initial(),
    ),
    // Computed only when something reads it, like the real subscription stream.
    channel: Atom.make(() => AsyncResult.success({ value: "first value" })),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: {
    pluginsLive: () => live,
    pluginChannel: () => channel,
    pluginFileHeaders: {
      label: "plugin-file-headers",
      run: async (_registry: unknown, input: { readonly url: string }) =>
        AsyncResult.success({ authorization: "DPoP relay-token", dpop: `proof for ${input.url}` }),
    },
    reportPluginWebFailure: {
      label: "plugin-web-failure",
      run: async (_registry: unknown, input: unknown) => {
        reportWebFailure(input);
        return AsyncResult.success({});
      },
    },
  } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPluginLoader } from "./pluginLoader";
import {
  pluginBannersAtom,
  pluginCommandsAtom,
  pluginComposerCollapseOnScrollAtom,
  pluginContributionKey,
  pluginRightPanelAtom,
  pluginRightPanelKey,
  pluginSlashCommandsAtom,
  pluginToolRendererAtom,
  pluginToolRendererKey,
  pluginWebFailureAtom,
} from "./pluginRegistry";

const webPlugin = (id: string): PluginState => ({
  id: PluginId.make(id),
  name: id,
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
  hasServer: false,
  hasWeb: true,
});

describe("startPluginLoader", () => {
  it("loads active web plugins, runs their commands, records one that fails, and unloads everything when stopped", async () => {
    const navigate = vi.fn();
    // A bundle that never arrives must not hold back the plugins after it.
    let releaseHungBundle: (response: Response) => void = () => {};
    const hungBundle = new Promise<Response>((resolve) => {
      releaseHungBundle = resolve;
    });
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/hung-web/")
          ? hungBundle
          : String(input).includes("/hello-web/")
            ? new Response(helloWebSource)
            : new Response("missing", { status: 500 }),
      );
    const environmentId = EnvironmentId.make("environment:plugin-loader");
    const helloPanel = pluginRightPanelAtom(
      pluginRightPanelKey(environmentId, "hello-web", "hello"),
    );
    const stop = startPluginLoader(environmentId, navigate);
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      live,
      AsyncResult.success({
        plugins: [
          webPlugin("hung-web"),
          webPlugin("hello-web"),
          { ...webPlugin("broken-web"), revision: 3 },
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(appAtomRegistry.get(helloPanel)?.title).toBe("Hello panel");
      expect(
        appAtomRegistry.get(
          pluginWebFailureAtom(pluginContributionKey(environmentId, "broken-web")),
        ),
      ).toBe("The request for /web.js failed with 500.");
    });
    // Agents' plugin tools hear about it through the server, tied to the start that failed.
    expect(reportWebFailure).toHaveBeenCalledWith({
      environmentId,
      input: {
        pluginId: "broken-web",
        revision: 3,
        message: "The request for /web.js failed with 500.",
      },
    });
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "http://plugins.test/api/plugins/hello-web/web.js?v=0.1.0",
    );
    expect(fetchSpy.mock.calls[1]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });

    const [command] = appAtomRegistry.get(pluginCommandsAtom(environmentId));
    expect(command?.command).toBe("plugin.hello-web.open-settings");
    command?.run();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings/plugins"));
    const [slashCommand] = appAtomRegistry.get(pluginSlashCommandsAtom(environmentId));
    expect(slashCommand?.name).toBe("hello");
    slashCommand?.run({ threadId: "thread-1" });
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginBannersAtom(environmentId))[0]?.description).toBe(
        "Thread thread-1",
      ),
    );

    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(1);
    const greetRenderer = pluginToolRendererAtom(
      pluginToolRendererKey(environmentId, "plg_hello-web_greet"),
    );
    expect(appAtomRegistry.get(greetRenderer)).toBeDefined();
    expect(appAtomRegistry.get(pluginComposerCollapseOnScrollAtom)).toBe(true);

    // Turning a plugin off takes effect while another still hangs, and a failed one isn't retried.
    const brokenFetches = () =>
      fetchSpy.mock.calls.filter(([input]) => String(input).includes("/broken-web/")).length;
    expect(brokenFetches()).toBe(1);
    appAtomRegistry.set(
      live,
      AsyncResult.success({
        plugins: [webPlugin("hung-web"), { ...webPlugin("broken-web"), revision: 3 }],
      }),
    );
    await vi.waitFor(() => expect(appAtomRegistry.get(helloPanel)).toBeUndefined());
    expect(brokenFetches()).toBe(1);

    stop();
    releaseHungBundle(new Response("missing", { status: 500 }));
    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(0);
    expect(appAtomRegistry.get(helloPanel)).toBeUndefined();
    expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginBannersAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(greetRenderer)).toBeUndefined();
    expect(appAtomRegistry.get(pluginComposerCollapseOnScrollAtom)).toBe(false);
  });

  it("reloads a restarted plugin and undoes what it registers after unloading", async () => {
    // Registers its panel only when the test releases it, after the loader may have stopped.
    const slowSource = `export default { activate(api) {
      return new Promise((release) => { globalThis.__releaseSlowPlugin = release; }).then(() =>
        api.rightPanel.register({ name: "slow", title: "Slow", component: () => null }));
    } };`;
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/hello-web/")
          ? new Response(helloWebSource)
          : new Response(slowSource),
      );
    const bundleRequests = (pluginId: string) =>
      fetchSpy.mock.calls.filter(([input]) => String(input).includes(`/${pluginId}/`)).length;
    const environmentId = EnvironmentId.make("environment:plugin-loader-reload");
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("hello-web")] }));
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toHaveLength(1),
    );
    appAtomRegistry.set(
      live,
      AsyncResult.success({ plugins: [{ ...webPlugin("hello-web"), revision: 2 }] }),
    );
    await vi.waitFor(() => expect(bundleRequests("hello-web")).toBe(2));

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("slow-web")] }));
    await vi.waitFor(() =>
      expect(Reflect.get(globalThis, "__releaseSlowPlugin")).toBeTypeOf("function"),
    );
    stop();
    const release = Reflect.get(globalThis, "__releaseSlowPlugin") as () => void;
    Reflect.deleteProperty(globalThis, "__releaseSlowPlugin");
    release();
    await Promise.resolve();
    expect(
      appAtomRegistry.get(
        pluginRightPanelAtom(pluginRightPanelKey(environmentId, "slow-web", "slow")),
      ),
    ).toBeUndefined();
  });

  it("starts a channel the plugin subscribes to and hands it the values", async () => {
    const channelSource = `export default { activate(api) {
      api.rpc.subscribe("notes", (value) => api.composer.showBanner({ title: String(value) }));
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(channelSource));
    const environmentId = EnvironmentId.make("environment:plugin-loader-channel");
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("channel-web")] }));

    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginBannersAtom(environmentId))[0]?.title).toBe("first value"),
    );
  });

  it("signs bundle requests with a DPoP proof over a T3 Connect link", async () => {
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("export default { activate() {} };"));
    const environmentId = EnvironmentId.make("environment:plugin-loader:relay");
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("relay-web")] }));

    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
        headers: {
          authorization: "DPoP relay-token",
          dpop: "proof for http://plugins.test/api/plugins/relay-web/web.js?v=0.1.0",
        },
      }),
    );
  });
});
