import type * as SdkUi from "@t3tools/plugin-sdk/ui";
import type { ComponentProps } from "react";
import { describe, expectTypeOf, it } from "vite-plus/test";

import type { Badge } from "../components/ui/badge";
import type { Button } from "../components/ui/button";
import type { EmptyMedia } from "../components/ui/empty";

type SdkProps<Name extends keyof typeof SdkUi> = Parameters<(typeof SdkUi)[Name]>[0];

// Checked by the typecheck: a T3 update that drops a variant the SDK offers fails here, before a
// plugin's button draws unstyled.
describe("the plugin UI kit", () => {
  it("offers only variants and sizes T3's own components have", () => {
    expectTypeOf<NonNullable<SdkProps<"Button">["variant"]>>().toExtend<
      NonNullable<ComponentProps<typeof Button>["variant"]>
    >();
    expectTypeOf<NonNullable<SdkProps<"Button">["size"]>>().toExtend<
      NonNullable<ComponentProps<typeof Button>["size"]>
    >();
    expectTypeOf<NonNullable<SdkProps<"Badge">["variant"]>>().toExtend<
      NonNullable<ComponentProps<typeof Badge>["variant"]>
    >();
    expectTypeOf<NonNullable<SdkProps<"Badge">["size"]>>().toExtend<
      NonNullable<ComponentProps<typeof Badge>["size"]>
    >();
    expectTypeOf<NonNullable<SdkProps<"EmptyMedia">["variant"]>>().toExtend<
      NonNullable<ComponentProps<typeof EmptyMedia>["variant"]>
    >();
  });
});
