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
  pluginCommandsAtom,
  pluginContributionKey,
  pluginRightPanelAtom,
  pluginRightPanelKey,
  pluginSlashCommandsAtom,
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
  it("loads active web plugins, runs their commands, records one that fails, and unloads them when stopped", async () => {
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
    expect(
      appAtomRegistry.get(pluginSlashCommandsAtom(environmentId)).map((entry) => entry.name),
    ).toEqual(["hello"]);

    stop();
    expect(appAtomRegistry.get(helloPanel)).toBeUndefined();
    expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toEqual([]);
  });
});
