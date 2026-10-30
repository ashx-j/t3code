import type { ReactNode } from "react";

/**
 * T3's own UI components. These exist only at runtime inside T3: build with
 * `@t3tools/plugin-sdk/vite`, which points this module at the app's copies.
 */
type UiComponent<Props = object> = (
  props: Props & {
    readonly [prop: string]: unknown;
    readonly className?: string;
    readonly children?: ReactNode;
  },
) => ReactNode;

export declare const Badge: UiComponent<{ readonly variant?: string }>;
export declare const Button: UiComponent<{
  readonly variant?: string;
  readonly size?: string;
  readonly onClick?: () => void;
}>;
export declare const Empty: UiComponent;
export declare const EmptyContent: UiComponent;
export declare const EmptyDescription: UiComponent;
export declare const EmptyHeader: UiComponent;
export declare const EmptyMedia: UiComponent<{ readonly variant?: string }>;
export declare const EmptyTitle: UiComponent;
export declare const Input: UiComponent;
export declare const Label: UiComponent;
export declare const Switch: UiComponent<{
  readonly checked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
}>;
export declare const Textarea: UiComponent;
