import {
  type PluginSettingsField,
  pluginSettingsForm,
} from "@t3tools/client-runtime/plugins/settings-form";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

// `null` is a saved secret the user cleared, removed when they save.
type DraftValue = string | boolean | null;
export type Draft = Readonly<Record<string, DraftValue>>;

const draftValue = (field: PluginSettingsField, value: Schema.Json | undefined) => {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : (field.defaultValue ?? false);
    case "secret":
      return "";
    case "list":
      return Array.isArray(value) ? value.join("\n") : "";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
};

/** The changed fields as a settings patch, or the first problem a user can fix before saving. */
export const toPatch = (
  fields: ReadonlyArray<PluginSettingsField>,
  saved: Draft,
  draft: Draft,
): { readonly patch: Schema.JsonObject } | { readonly problem: string } => {
  const patch: Record<string, Schema.Json> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === saved[field.key] || value === undefined) continue;
    if (value === null) {
      patch[field.key] = null;
    } else if (typeof value === "boolean") {
      patch[field.key] = value;
    } else if (field.kind === "secret") {
      if (value !== "") patch[field.key] = value;
    } else if (value.trim() === "") {
      patch[field.key] = null;
    } else if (field.kind === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { problem: `${field.label} must be a number.` };
      patch[field.key] = parsed;
    } else if (field.kind === "select") {
      patch[field.key] = field.options.find((option) => String(option) === value) ?? value;
    } else if (field.kind === "list") {
      patch[field.key] = value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } else {
      patch[field.key] = value;
    }
  }
  return { patch };
};

const parseJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/**
 * A settings form drawn from a JSON Schema, for plugins and for provider drivers that come from
 * plugins. `onSave` gets the changed fields, with `null` for a cleared one, and resolves with the
 * settings as saved or the reason they were not.
 */
export function JsonSchemaSettingsForm({
  idPrefix,
  label,
  schema,
  settings,
  canSave,
  onSave,
}: {
  readonly idPrefix: string;
  readonly label: string;
  readonly schema: Schema.JsonObject | undefined;
  readonly settings: Schema.JsonObject;
  readonly canSave: boolean;
  readonly onSave: (
    patch: Schema.JsonObject,
  ) => Promise<{ readonly settings: Schema.JsonObject } | { readonly problem: string }>;
}) {
  const form = pluginSettingsForm(schema);
  const fields = form.kind === "fields" ? form.fields : [];
  const toDraft = (values: Schema.JsonObject): Draft =>
    Object.fromEntries(fields.map((field) => [field.key, draftValue(field, values[field.key])]));
  const [savedSettings, setSavedSettings] = useState(settings);
  const [saved, setSaved] = useState(() => toDraft(settings));
  const [draft, setDraft] = useState(saved);
  const [json, setJson] = useState(() => JSON.stringify(settings, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next =
      form.kind === "json"
        ? (() => {
            const parsed = parseJsonObject(json);
            return Option.isSome(parsed)
              ? { patch: parsed.value }
              : { problem: "Settings must be a JSON object." };
          })()
        : toPatch(fields, saved, draft);
    if ("problem" in next) return setProblem(next.problem);
    setBusy(true);
    const result = await onSave(next.patch);
    setBusy(false);
    if ("problem" in result) return setProblem(result.problem);
    setProblem(null);
    setSavedSettings(result.settings);
    const savedDraft = toDraft(result.settings);
    setSaved(savedDraft);
    setDraft(savedDraft);
    setJson(JSON.stringify(result.settings, null, 2));
  };

  return (
    <div className="space-y-3 border-t py-3">
      {form.kind === "json" ? (
        <Textarea
          aria-label={`${label} settings JSON`}
          rows={8}
          value={json}
          onChange={(event) => setJson(event.target.value)}
        />
      ) : (
        fields.map((field) => (
          <JsonSchemaFieldView
            key={field.key}
            id={`${idPrefix}-${field.key}`}
            field={field}
            value={draft[field.key]}
            hasSecret={savedSettings[field.key] !== undefined}
            onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
          />
        ))
      )}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function JsonSchemaFieldView({
  id,
  field,
  value,
  hasSecret,
  onChange,
}: {
  readonly id: string;
  readonly field: PluginSettingsField;
  readonly value: DraftValue | undefined;
  readonly hasSecret: boolean;
  readonly onChange: (value: DraftValue) => void;
}) {
  const text = typeof value === "string" ? value : "";
  // What the plugin gets while the field is empty.
  const fallback =
    field.kind === "secret" || field.kind === "boolean" || field.defaultValue === undefined
      ? undefined
      : field.kind === "list"
        ? field.defaultValue.join(", ")
        : String(field.defaultValue);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? " *" : ""}
      </Label>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {field.kind === "boolean" ? (
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      ) : field.kind === "select" ? (
        <Select value={text} onValueChange={(next) => typeof next === "string" && onChange(next)}>
          <SelectTrigger id={id} size="sm" aria-label={field.label}>
            <SelectValue>
              {text || (fallback === undefined ? "" : `${fallback} (default)`)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {field.options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : field.kind === "list" ? (
        <Textarea
          id={id}
          rows={3}
          placeholder={
            fallback === undefined
              ? "One value per line"
              : `One value per line. Default: ${fallback}`
          }
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === "secret" ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            placeholder={
              value === null
                ? "Removed when you save"
                : hasSecret
                  ? "Saved. Type to replace."
                  : "Not set"
            }
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
          {hasSecret && value !== null ? (
            <Button size="sm" variant="outline" onClick={() => onChange(null)}>
              Clear
            </Button>
          ) : null}
        </div>
      ) : (
        <Input
          id={id}
          type={field.kind === "number" ? "number" : "text"}
          autoComplete="off"
          placeholder={fallback === undefined ? undefined : `Default: ${fallback}`}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
