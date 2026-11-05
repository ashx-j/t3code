import type { ChangeEvent, ReactNode } from "react";

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

export declare const Badge: UiComponent<{
  readonly variant?:
    | "default"
    | "destructive"
    | "error"
    | "info"
    | "outline"
    | "secondary"
    | "success"
    | "warning";
  readonly size?: "default" | "sm" | "lg";
}>;
export declare const Button: UiComponent<{
  readonly variant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "ghost-muted"
    | "ghost-destructive"
    | "link"
    | "outline"
    | "secondary"
    | "warning-outline";
  readonly size?:
    | "default"
    | "xs"
    | "sm"
    | "lg"
    | "xl"
    | "icon-xs"
    | "icon-sm"
    | "icon"
    | "icon-lg"
    | "icon-xl";
  readonly onClick?: () => void;
}>;
export declare const Empty: UiComponent;
export declare const EmptyContent: UiComponent;
export declare const EmptyDescription: UiComponent;
export declare const EmptyHeader: UiComponent;
export declare const EmptyMedia: UiComponent<{ readonly variant?: "default" | "icon" }>;
export declare const EmptyTitle: UiComponent;
export declare const Input: UiComponent<{
  readonly value?: string;
  readonly onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}>;
export declare const Label: UiComponent;
export declare const Switch: UiComponent<{
  readonly checked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
}>;
export declare const Textarea: UiComponent<{
  readonly value?: string;
  readonly onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}>;
