import { render } from "../../../test/render";
import { PluginId, type PluginState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const { state, setEnabled, setEnabledCommand } = vi.hoisted(() => ({
  state: { plugins: [] as ReadonlyArray<PluginState> },
  setEnabled: vi.fn(async (_request: unknown) => ({ _tag: "Success" as const, value: {} })),
  setEnabledCommand: { permissionAtom: (): unknown => null },
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === setEnabledCommand ? setEnabled : vi.fn()) as never,
}));
vi.mock(import("../../state/plugins"), () => ({
  pluginEnvironment: {
    pluginsLive: () => "plugins-live",
    setPluginEnabled: setEnabledCommand,
    // Install and removal share the enable permission here; the test exercises neither.
    installPlugin: { permissionAtom: () => setEnabledCommand.permissionAtom() },
    uninstallPlugin: { permissionAtom: () => setEnabledCommand.permissionAtom() },
  } as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === "plugins-live" ? { plugins: state.plugins } : null,
    error: null,
  })) as never,
}));
// The real row and page wire in scope and inheritance UI this page does not use.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  )) as never,
  SettingsRow: (({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment" },
    environment: {
      environmentId: "env",
      label: "MAC1",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { plugins: true } } },
    },
  })) as never,
}));

import { Atom } from "effect/reactivity";

import { PluginsSettings } from "./PluginsSettings";

const allowed = Atom.make(true);

const disabledPlugin: Omit<PluginState, "id" | "name"> = {
  version: "0.1.0",
  permissions: [],
  source: "installed",
  enabled: false,
  status: "disabled",
  hasServer: true,
  hasWeb: false,
};

function setup(plugins: ReadonlyArray<PluginState>) {
  setEnabled.mockClear();
  setEnabledCommand.permissionAtom = () => allowed;
  state.plugins = plugins;
}

describe("PluginsSettings", () => {
  it("enables a plugin through the command and shows why another failed", async () => {
    setup([
      { ...disabledPlugin, id: PluginId.make("hello-plugin"), name: "Hello" },
      {
        ...disabledPlugin,
        id: PluginId.make("broken-plugin"),
        name: "Broken",
        enabled: true,
        status: "failed",
        failure: { stage: "activate", message: "broken-plugin refuses to start" },
      },
    ]);
    await using _screen = await render(<PluginsSettings />);

    // The settings row lays the switch out past the test frame's viewport, so click it directly.
    page
      .getByRole("switch", { name: "Enable Hello" })
      .first()
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(setEnabled).toHaveBeenCalledExactlyOnceWith({
        environmentId: "env",
        input: { pluginId: "hello-plugin", enabled: true },
      }),
    );
    await expect
      .element(page.getByText("Failed to start: broken-plugin refuses to start"))
      .toBeVisible();
  });
});
