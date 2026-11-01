import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePluginProviderIconUrl,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});

describe("resolvePluginProviderIconUrl", () => {
  it("uses the snapshot icon only for drivers without a client definition", () => {
    const iconUrl = "data:image/svg+xml,%3Csvg/%3E";
    expect(
      resolvePluginProviderIconUrl({ driverKind: ProviderDriverKind.make("echoAgent"), iconUrl }),
    ).toBe(iconUrl);
    expect(
      resolvePluginProviderIconUrl({ driverKind: ProviderDriverKind.make("codex"), iconUrl }),
    ).toBeNull();
  });
});
