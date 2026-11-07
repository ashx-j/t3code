import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, PluginId, ThreadId, type PluginState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import helloWebSource from "../../../../packages/plugin-sdk/fixtures/hello-web/web.js?raw";
import { fakeTimers } from "../../test/render";

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
import { startPluginStyles } from "./pluginStyles";
import {
  pluginActionAtoms,
  pluginBannersAtom,
  pluginCommandsAtom,
  pluginContributionKey,
  pluginPageAtom,
  pluginPageKey,
  pluginReplacementAtoms,
  pluginRightPanelAtom,
  pluginRightPanelKey,
  pluginSettingsPanelAtom,
  pluginSidebarSectionsAtom,
  pluginSlashCommandsAtom,
  pluginToolRendererAtom,
  pluginToolRendererKey,
  pluginThreadBadgesAtom,
  pluginWebFailuresAtom,
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
            : String(input).includes("/no-activate-web/")
              ? new Response("export default {};")
              : new Response("missing", { status: 500 }),
      );
    const environmentId = EnvironmentId.make("environment:plugin-loader");
    const helloPanel = pluginRightPanelAtom(
      pluginRightPanelKey(environmentId, "hello-web", "hello"),
    );
    const stop = startPluginLoader(environmentId, navigate, true);
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      live,
      AsyncResult.success({
        plugins: [
          webPlugin("hung-web"),
          webPlugin("hello-web"),
          { ...webPlugin("broken-web"), revision: 3 },
          { ...webPlugin("no-activate-web"), revision: 4 },
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(appAtomRegistry.get(helloPanel)?.title).toBe("Hello panel");
      expect(appAtomRegistry.get(pluginWebFailuresAtom("broken-web")).get(environmentId)).toBe(
        "The request for /web.js failed with 500.",
      );
    });
    // Agents' plugin tools hear about the plugin's own failures through the server, tied to the
    // start that failed. A failed download is this client's network, so it stays here.
    await vi.waitFor(() =>
      expect(reportWebFailure).toHaveBeenCalledWith({
        environmentId,
        input: {
          pluginId: "no-activate-web",
          revision: 4,
          message: "The web bundle does not export a plugin with an activate function.",
        },
      }),
    );
    expect(reportWebFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ pluginId: "broken-web" }) }),
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "http://plugins.test/api/plugins/hello-web/web.js?v=0.1.0",
    );
    expect(fetchSpy.mock.calls[1]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });
    // A plugin's atoms come from the app's own copy of effect, so the app's registry runs them.
    expect(Reflect.get(globalThis, "__t3PluginHost")).toMatchObject({ atom: { make: Atom.make } });

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

    // Turning a plugin off takes effect while another still hangs. A failed download is tried
    // again on that change; a bundle that downloaded and then failed waits for a restart.
    const fetches = (pluginId: string) =>
      fetchSpy.mock.calls.filter(([input]) => String(input).includes(`/${pluginId}/`)).length;
    expect(fetches("broken-web")).toBe(1);
    expect(fetches("no-activate-web")).toBe(1);
    appAtomRegistry.set(
      live,
      AsyncResult.success({
        plugins: [
          webPlugin("hung-web"),
          { ...webPlugin("broken-web"), revision: 3 },
          { ...webPlugin("no-activate-web"), revision: 4 },
        ],
      }),
    );
    await vi.waitFor(() => expect(appAtomRegistry.get(helloPanel)).toBeUndefined());
    await vi.waitFor(() => expect(fetches("broken-web")).toBe(2));
    expect(fetches("no-activate-web")).toBe(1);

    stop();
    releaseHungBundle(new Response("missing", { status: 500 }));
    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(0);
    expect(appAtomRegistry.get(helloPanel)).toBeUndefined();
    expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(pluginBannersAtom(environmentId))).toEqual([]);
    expect(appAtomRegistry.get(greetRenderer)).toBeUndefined();
  });

  it("tries a download again after a bad gateway", async () => {
    let badGateways = 1;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        badGateways-- > 0
          ? new Response("bad gateway", { status: 502 })
          : new Response(helloWebSource),
      );
    using _timers = fakeTimers();
    const environmentId = EnvironmentId.make("environment:plugin-loader-retry");
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("hello-web")] }));
    using _loader = { [Symbol.dispose]: startPluginLoader(environmentId, vi.fn(), true) };

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toHaveLength(1),
    );
    expect(
      appAtomRegistry.get(pluginWebFailuresAtom("hello-web")).get(environmentId),
    ).toBeUndefined();
  });

  it("reloads a restarted plugin and undoes what it registers after unloading", async () => {
    // The first start registers only when the test releases it, after a restart replaced it.
    const slowSource = `export default { activate(api) {
      const settings = () => api.settings.registerPanel(() => null);
      if (globalThis.__releaseSlowPlugin) return settings();
      return new Promise((release) => { globalThis.__releaseSlowPlugin = release; }).then(() => {
        settings();
        api.rightPanel.register({ name: "slow", title: "Slow", component: () => null });
      });
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
    const stop = startPluginLoader(environmentId, vi.fn(), true);
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
    appAtomRegistry.set(
      live,
      AsyncResult.success({ plugins: [{ ...webPlugin("slow-web"), revision: 2 }] }),
    );
    const settingsPanel = pluginSettingsPanelAtom(pluginContributionKey(environmentId, "slow-web"));
    await vi.waitFor(() => expect(appAtomRegistry.get(settingsPanel)).toBeDefined());
    const release = Reflect.get(globalThis, "__releaseSlowPlugin") as () => void;
    Reflect.deleteProperty(globalThis, "__releaseSlowPlugin");
    release();
    await Promise.resolve();
    expect(appAtomRegistry.get(settingsPanel)).toBeDefined();
    expect(
      appAtomRegistry.get(
        pluginRightPanelAtom(pluginRightPanelKey(environmentId, "slow-web", "slow")),
      ),
    ).toBeUndefined();
    stop();
    expect(appAtomRegistry.get(settingsPanel)).toBeUndefined();
  });

  it("gives a shared slash command to the plugin whose id sorts first, and ignores a plugin's calls after it unloads", async () => {
    const source = (id: string) => `export default { activate(api) {
      globalThis.__api_${id} = api;
      api.composer.registerSlashCommand({ name: "notes", description: "${id}", run() {} });
      api.commands.register({ id: "open", title: "Open ${id}", run() {} });
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input) =>
          new Response(source(String(input).includes("/first-web/") ? "first" : "second")),
      );
    const environmentId = EnvironmentId.make("environment:plugin-loader-clash");
    const stop = startPluginLoader(environmentId, vi.fn(), true);
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      live,
      AsyncResult.success({ plugins: [webPlugin("first-web"), webPlugin("second-web")] }),
    );
    // Both start, whatever order they finish in, and `/notes` belongs to first-web.
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toHaveLength(2),
    );
    expect(
      appAtomRegistry.get(pluginSlashCommandsAtom(environmentId)).map((entry) => entry.pluginId),
    ).toEqual(["first-web"]);

    // A timer the plugin left running changes nothing once it is off.
    const api = Reflect.get(globalThis, "__api_first") as {
      readonly threads: { readonly setBadge: (threadId: string, badge: object) => void };
    };
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("second-web")] }));
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(pluginCommandsAtom(environmentId))).toHaveLength(1),
    );
    // Without first-web, second-web's `/notes` takes over.
    expect(
      appAtomRegistry.get(pluginSlashCommandsAtom(environmentId)).map((entry) => entry.pluginId),
    ).toEqual(["second-web"]);
    api.threads.setBadge("thread-1", { label: "Late" });
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make("thread-1")));
    expect(appAtomRegistry.get(pluginThreadBadgesAtom(threadKey))).toEqual([]);
  });

  it("keeps each environment's thread contributions to its own threads and takes app-wide ones from the first", async () => {
    // Thread parts only from environment B, app-wide parts from both.
    const source = `export default { activate(api) {
      api.commands.register({ id: "open", title: "Open", run() {} });
      api.pages.register({ name: "all", title: "All notes", component: () => null });
      api.sidebar.addSection({ id: "recent", title: "Recent", component: () => null });
      api.markdown.registerCodeBlock({ language: "notes", component: () => null });
      if (!api.environmentId.endsWith(":b")) return;
      api.composer.registerSlashCommand({ name: "notes", description: "Notes", run() {} });
      api.threads.addHeaderButton({ id: "flag", title: "Flag", run() {} });
      api.ui.replace("message.user", () => null);
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(source));
    const environmentA = EnvironmentId.make("environment:plugin-loader-scope:a");
    const environmentB = EnvironmentId.make("environment:plugin-loader-scope:b");
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("notes-web")] }));
    using _a = { [Symbol.dispose]: startPluginLoader(environmentA, vi.fn(), true) };
    using _b = { [Symbol.dispose]: startPluginLoader(environmentB, vi.fn(), false) };

    await vi.waitFor(() => {
      expect(appAtomRegistry.get(pluginCommandsAtom(environmentA))).toHaveLength(1);
      expect(
        appAtomRegistry.get(pluginReplacementAtoms["message.user"](environmentB)),
      ).toBeDefined();
    });
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentA))).toEqual([]);
    expect(appAtomRegistry.get(pluginSlashCommandsAtom(environmentB))).toHaveLength(1);
    expect(appAtomRegistry.get(pluginActionAtoms.threadHeader(environmentA))).toEqual([]);
    expect(appAtomRegistry.get(pluginActionAtoms.threadHeader(environmentB))).toHaveLength(1);
    expect(
      appAtomRegistry.get(pluginReplacementAtoms["message.user"](environmentA)),
    ).toBeUndefined();
    // A page, command or section has no thread to say which environment it belongs to.
    expect(appAtomRegistry.get(pluginCommandsAtom(environmentB))).toEqual([]);
    expect(
      appAtomRegistry.get(pluginPageAtom(pluginPageKey("notes-web", "all")))?.owner.environmentId,
    ).toBe(environmentA);
    expect(
      appAtomRegistry.get(pluginSidebarSectionsAtom).map((section) => section.owner.environmentId),
    ).toEqual([environmentA]);
    // The same plugin claims its code block language from each environment without failing.
    expect(appAtomRegistry.get(pluginWebFailuresAtom("notes-web")).size).toBe(0);
  });

  it("starts a channel the plugin subscribes to and hands it the values", async () => {
    const channelSource = `export default { activate(api) {
      api.rpc.subscribe("notes", (value) => api.composer.showBanner({ title: String(value) }));
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(channelSource));
    const environmentId = EnvironmentId.make("environment:plugin-loader-channel");
    const stop = startPluginLoader(environmentId, vi.fn(), true);
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
    // Set first, so the loader's first request isn't for a plugin an earlier case left listed.
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [webPlugin("relay-web")] }));
    const stop = startPluginLoader(environmentId, vi.fn(), true);
    using _loader = { [Symbol.dispose]: stop };

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

describe("startPluginStyles", () => {
  it("adds an active plugin's stylesheets in order, swaps changed ones and removes them when it is off", async () => {
    // Each sheet names the file and revision it was fetched as.
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(`/* ${url.pathname.split("/").pop()} ${url.searchParams.get("v")} */`);
    });
    const environmentId = EnvironmentId.make("environment:plugin-styles");
    const stylesPlugin: PluginState = {
      ...webPlugin("styles-plugin"),
      hasWeb: false,
      styles: [
        { file: "base.css", revision: "r1" },
        { file: "compact.css", revision: "r2" },
      ],
    };
    const sheets = () =>
      Array.from(document.querySelectorAll('style[data-plugin="styles-plugin"]'), (sheet) =>
        sheet.textContent?.trim(),
      );
    appAtomRegistry.set(live, AsyncResult.success({ plugins: [stylesPlugin] }));
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
      live,
      AsyncResult.success({
        plugins: [
          { ...webPlugin("styles-plugin"), hasWeb: false, enabled: false, status: "disabled" },
        ],
      }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual([]));

    appAtomRegistry.set(live, AsyncResult.success({ plugins: [stylesPlugin] }));
    await vi.waitFor(() => expect(sheets()).toHaveLength(2));
    stop();
    expect(sheets()).toEqual([]);
  });
});
