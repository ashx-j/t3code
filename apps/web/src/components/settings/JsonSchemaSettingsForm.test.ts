import { pluginSettingsForm } from "@t3tools/client-runtime/plugins/settings-form";
import { describe, expect, it } from "vite-plus/test";

import { toJsonPatch, toPatch } from "./JsonSchemaSettingsForm";

const form = pluginSettingsForm({
  type: "object",
  properties: {
    token: { type: "string", format: "t3-secret" },
    name: { type: "string" },
  },
});
const fields = form.kind === "fields" ? form.fields : [];

describe("toPatch", () => {
  it("sends only changed fields, removes a cleared secret and keeps an untouched one", () => {
    const saved = { token: "", name: "Ash" };
    expect(toPatch(fields, saved, { token: null, name: "Ash" })).toEqual({
      patch: { token: null },
    });
    expect(toPatch(fields, saved, { token: "", name: " " })).toEqual({ patch: { name: null } });
    expect(toPatch(fields, saved, { token: "new", name: "Ash" })).toEqual({
      patch: { token: "new" },
    });
  });
});

describe("toJsonPatch", () => {
  it("removes a key deleted from the JSON", () => {
    expect(toJsonPatch({ a: 1, b: { c: 2 } }, '{ "b": { "c": 3 } }')).toEqual({
      patch: { a: null, b: { c: 3 } },
    });
    expect(toJsonPatch({ a: 1 }, "[]")).toEqual({ problem: "Settings must be a JSON object." });
  });
});
