import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { RefObject } from "react";

import { pluginComposerCollapseOnScrollAtom } from "../../plugins/pluginRegistry";
import { timelineAwayFromEndAtom } from "./useTimelineFollow";

const NEVER_AWAY_FROM_END = Atom.make(false);

/**
 * Folds the composer on wide screens while a plugin asks for it and the timeline is scrolled up.
 * Leaving the end blurs the composer's editor when it can fold, since a wide screen keeps it
 * focused while the wheel scrolls; focusing it again unfolds it. `active` is false on phones,
 * which fold on their own.
 */
export function useComposerCollapseOnScroll(input: {
  readonly wideScreen: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly formRef: RefObject<HTMLFormElement | null>;
  /** False while a multi-line prompt, a question or a forced expansion keeps it open. */
  readonly canFold: boolean;
}) {
  const active = useAtomValue(pluginComposerCollapseOnScrollAtom) && input.wideScreen;
  const awayAtom = active
    ? timelineAwayFromEndAtom(scopedThreadKey(input.threadRef))
    : NEVER_AWAY_FROM_END;
  useAtomSubscribe(awayAtom, (away) => {
    const focused = document.activeElement;
    if (
      away &&
      input.canFold &&
      focused instanceof HTMLElement &&
      focused.isContentEditable &&
      input.formRef.current?.contains(focused)
    ) {
      focused.blur();
    }
  });
  return { active, awayFromEnd: useAtomValue(awayAtom) };
}
