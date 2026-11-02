import { useAtomValue } from "@effect/atom-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { pluginSidebarSectionsAtom } from "./pluginRegistry";

/** Plugin sections between the thread list and the sidebar's footer; nothing without plugins. */
export function PluginSidebarSections() {
  const sections = useAtomValue(pluginSidebarSectionsAtom);
  if (sections.length === 0) return null;
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-border/60 border-t px-2 py-2">
      {sections.map((section) => {
        const Section = section.component;
        return (
          <section key={section.key} aria-label={section.title} className="py-1">
            <h3 className="px-2 pb-1 font-medium text-2xs text-muted-foreground">
              {section.title}
            </h3>
            <RenderErrorBoundary resetKeys={[section]} fallback={null}>
              <Section />
            </RenderErrorBoundary>
          </section>
        );
      })}
    </div>
  );
}
