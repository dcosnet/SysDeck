import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";
import { Spinner } from "./spinner";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "destructive-outline";

export type ButtonSize = "default" | "sm" | "icon" | "icon-sm";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
  outline: "border border-input bg-transparent hover:bg-accent",
  ghost: "hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground " +
    "hover:bg-destructive/90",
  "destructive-outline": "border border-destructive/40 text-destructive " +
    "hover:bg-destructive/10",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "h-(--control-h) px-4",
  sm: "h-(--control-h-sm) px-3",
  icon: "size-(--control-h)",
  "icon-sm": "size-(--control-h-sm)",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = "default",
      size = "default",
      isLoading = false,
      disabled,
      children,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        className={cn(
          "hit-target inline-flex items-center justify-center gap-2",
          "whitespace-nowrap rounded-md text-sm font-medium",
          "transition-colors duration-(--motion-fast)",
          "disabled:pointer-events-none disabled:opacity-50",
          "[&_svg]:size-4 [&_svg]:shrink-0",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...props}
      >
        {isLoading && <Spinner />}
        {children}
      </button>
    );
  },
);
