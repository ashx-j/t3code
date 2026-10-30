import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import helloWebSource from "../../../../packages/plugin-sdk/fixtures/hello-web/web.js?raw";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: { _tag: "Bearer", token: "token" },
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
  pluginEnvironment: { pluginsLive: () => live } as never,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPluginLoader } from "./pluginLoader";
import {
  pluginBannersAtom,
  pluginCommandsAtom,
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
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/hello-web/")
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
      AsyncResult.success({ plugins: [webPlugin("hello-web"), webPlugin("broken-web")] }),
    );

    await vi.waitFor(() => {
      expect(appAtomRegistry.get(helloPanel)?.title).toBe("Hello panel");
      expect(
        appAtomRegistry.get(
          pluginWebFailureAtom(pluginContributionKey(environmentId, "broken-web")),
        ),
      ).toBe("The request for /web.js failed with 500.");
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "http://plugins.test/api/plugins/hello-web/web.js?v=0.1.0",
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });

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

    stop();
    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(0);
    expect(appAtomRegistry.get(helloPanel)).toBeUndefined();
    expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginBannersAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(greetRenderer)).toBeUndefined();
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
});
