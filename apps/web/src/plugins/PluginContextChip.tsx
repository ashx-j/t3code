import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { BlocksIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "../components/ContextChip";
import { UnresolvedChip } from "../components/contextChipParts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { pluginMentionItemAtom } from "./pluginUi";

const TEXT_PREVIEW_CHARS = 280;

/** Inline chip for a plugin `@` item, in the composer and in sent messages. */
function PluginContextChip(props: {
  label: string;
  pluginName: string | undefined;
  text: string | undefined;
  copyMarkdown?: string;
}) {
  const preview =
    props.text !== undefined && props.text.length > TEXT_PREVIEW_CHARS
      ? `${props.text.slice(0, TEXT_PREVIEW_CHARS)}…`
      : props.text;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            tabIndex={0}
            aria-label={`Plugin item, ${props.label}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <BlocksIcon />
            <ContextChipLabel>{props.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-80">
        <div className="text-muted-foreground">{props.pluginName ?? "Plugin"}</div>
        {preview ? <div className="whitespace-pre-wrap">{preview}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

const PluginContextPayload = Schema.Struct({
  plugin: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const isPluginContextPayload = Schema.is(PluginContextPayload);

/** A sent message's chip shows the text its record carried, whether or not the plugin is on. */
export function SentPluginContextChip(props: { label: string; payload: unknown }) {
  const payload = isPluginContextPayload(props.payload) ? props.payload : undefined;
  return (
    <PluginContextChip label={props.label} pluginName={payload?.plugin} text={payload?.text} />
  );
}

/** The composer's chip reads the live item, so it shows as unavailable once its plugin drops it. */
export function ComposerPluginContextChip(props: { contextId: string; label: string }) {
  const item = useAtomValue(pluginMentionItemAtom(props.contextId));
  if (item === undefined) {
    return (
      <UnresolvedChip
        label={props.label}
        tooltip="This plugin item isn't available. Its plugin may be off or still loading; turn it on or remove the item."
      />
    );
  }
  return <PluginContextChip label={props.label} pluginName={item.pluginName} text={item.text} />;
}
