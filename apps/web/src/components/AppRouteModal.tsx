import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { PluginReplaceable } from "../plugins/PluginReplaceable";
import { registerCommands } from "../shortcuts/dispatcher";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Set inside the page frame, where no dialog exists for the close button to close.
const AppRoutePageCloseContext = createContext<(() => void) | null>(null);

/**
 * Large modal for the Settings and Usage routes. Esc, the close button, or a press on the
 * backdrop returns to the page that opened it. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts. A plugin may show the page in
 * place of the thread instead (the `app.pageFrame` part).
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);

  const modal = (
    <DialogPrimitive.Root
      open={open}
      // Portaled layers outside this tree (toasts, Clerk, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={false}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-safe max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
  return (
    <PluginReplaceable
      part="app.pageFrame"
      original={modal}
      pieces={{
        original: modal,
        content: children,
        page: <AppRoutePage label={label}>{children}</AppRoutePage>,
        label,
        close: () => void closeAppModal(),
      }}
    />
  );
}

/**
 * Settings or Usage in place of the thread, beside the sidebar. The thread stays mounted under it
 * (see `index.css`). Esc goes back unless a popup or dialog inside the page takes it.
 */
function AppRoutePage({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const pageRef = useRef<HTMLElement>(null);
  const close = () => {
    // Leaving unmounts a focused field without a blur, so commit-on-blur rows would drop what
    // was typed. Blur first so they commit.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && pageRef.current?.contains(focused)) focused.blur();
    void closeAppModal();
  };
  const onEscape = useEffectEvent(close);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds Esc in the global shortcut dispatcher while the page is shown
  useEffect(
    () =>
      registerCommands(
        {},
        {
          observe: (event, consumed) => {
            if (consumed || event.repeat || event.isComposing || event.key !== "Escape") return;
            if (
              event.target instanceof Element &&
              event.target.closest('[role="dialog"], [role="alertdialog"], [data-slot$="popup"]')
            ) {
              return;
            }
            event.preventDefault();
            onEscape();
          },
        },
      ),
    [],
  );
  return (
    <SidebarInset
      ref={pageRef}
      aria-label={label}
      data-app-modal=""
      data-app-route-page=""
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      <AppRoutePageCloseContext value={close}>{children}</AppRoutePageCloseContext>
    </SidebarInset>
  );
}

export function AppRouteModalClose() {
  const closePage = use(AppRoutePageCloseContext);
  if (closePage) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label="Close" onClick={closePage} />}
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label="Close"
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
