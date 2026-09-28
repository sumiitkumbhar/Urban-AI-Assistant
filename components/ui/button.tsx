"use client";

import * as React from "react";
import { Spinner } from "./icons";
import { cn } from "@/lib/utils";

// Generic reusable button. Not currently imported anywhere in the app (a
// grep across components/app/lib turns up nothing) - kept for future use,
// per this codebase's own "dead but type-correct code stays" convention
// (see DocumentPanel.tsx's InteractiveDocumentView/SelectionCommandBox/
// BlockEditOverlay trio for the precedent). Brought onto the warm-paper
// system on 2026-09-28 so it's correct at rest, not just when it's next
// wired up - see DESIGN.md's "Reference discipline: Apple HIG & SF Symbols"
// section for why: this component used to be the one place in the app that
// broke the locked "one accent, and it is ink" rule (bg-blue-600 etc.),
// hover-scaled on buttons (an explicit anti-pattern), and pulled icons from
// a second library (lucide-react's Loader2) instead of this app's own
// hand-rolled icon system.
export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "primary",
      size = "md",
      loading = false,
      disabled = false,
      icon,
      iconPosition = "left",
      fullWidth = false,
      className,
      ...props
    },
    ref
  ) => {
    // One accent, and it is ink (DESIGN.md, locked). "success" used to be a
    // second, green accent; it now renders exactly like "primary" - if a
    // future call site genuinely needs to say "this specific action
    // succeeded" rather than just "this is the primary action", that's a
    // checkmark icon on an ink button, not a colour swap. "danger" keeps red:
    // DESIGN.md reserves semantic colour for "errors" by name, so a
    // destructive-action button is the one legitimate second colour here.
    const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
      primary:
        "bg-[var(--ink)] text-[var(--paper)] hover:bg-[var(--ink-secondary)] hover:shadow-paper-md",
      secondary:
        "bg-[var(--paper-raised)] text-[var(--ink)] border border-[var(--rule)] hover:bg-[var(--paper-sunken)] hover:border-[var(--rule-strong)]",
      ghost:
        "text-[var(--ink-secondary)] hover:bg-[var(--paper-sunken)] hover:text-[var(--ink)]",
      danger:
        "bg-red-600 text-white hover:bg-red-700 shadow-paper-sm hover:shadow-paper-md",
      success:
        "bg-[var(--ink)] text-[var(--paper)] hover:bg-[var(--ink-secondary)] hover:shadow-paper-md",
    };

    const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
      sm: "px-3 py-1.5 text-sm",
      md: "px-4 py-2 text-base",
      lg: "px-6 py-3 text-lg",
    };

    const iconSizes: Record<NonNullable<ButtonProps["size"]>, string> = {
      sm: "h-3.5 w-3.5",
      md: "h-4 w-4",
      lg: "h-5 w-5",
    };

    return (
      <button
        ref={ref}
        className={cn(
          // Interactive pill, per DESIGN.md's shape system - buttons are
          // --r-pill, not an arbitrary radius.
          "press inline-flex items-center justify-center rounded-full font-medium",
          // Depress on :active via .press (globals.css); hover changes
          // background and shadow only - no hover-scale (explicit
          // DESIGN.md anti-pattern), and only the properties that actually
          // change are listed, never `transition: all`.
          "transition-[background-color,box-shadow,border-color] duration-200 ease-settle",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          variants[variant],
          sizes[size],
          fullWidth && "w-full",
          className
        )}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <Spinner
            className={cn("animate-spin", iconSizes[size], Boolean(children) && "mr-2")}
          />
        )}
        {!loading && icon && iconPosition === "left" && (
          <span className={cn(iconSizes[size], Boolean(children) && "mr-2")}>
            {icon}
          </span>
        )}
        {children}
        {!loading && icon && iconPosition === "right" && (
          <span className={cn(iconSizes[size], Boolean(children) && "ml-2")}>
            {icon}
          </span>
        )}
      </button>
    );
  }
);
Button.displayName = "Button";
