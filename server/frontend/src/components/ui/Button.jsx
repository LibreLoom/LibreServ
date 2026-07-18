/**
 * Button — the canonical button primitive, built on shadcn/ui architecture.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONVENTION — when to use each variant
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. SOLID (color invert + scale on hover) — the default. Use for actions.
 *    primary   — page-bg fill. Hover → accent. Use on CARDS only.
 *                The single most important action on a card surface.
 *    secondary — card-bg fill. Hover → accent. Use on the PAGE only.
 *                The primary action when rendered directly on the page bg.
 *    accent    — CAUTION/DANGER fill. Hover → surface-aware invert with an
 *                error ring. Use for actions that are destructive, hard to
 *                undo, or have significant side effects: "Remove", "Revoke",
 *                "Reset Password", "Force Update", "Deactivate", etc.
 *    danger    — error fill. Hover → accent. SEVERE destructive actions ONLY.
 *                "Delete", "Uninstall", "Factory Reset", "Erase".
 *
 *    All solid variants scale to 105% on hover (transform-based, no layout
 *    shift). primary/secondary are surface-restricted: their bg is a surface
 *    color, so they only contrast on the OPPOSITE surface. Their hover goes
 *    to accent which contrasts with both surfaces, so the button never
 *    vanishes.
 *
 * 2. OUTLINE (transparent, fills + scales on hover) — medium emphasis.
 *    Use for secondary actions, especially Cancel/Back/Dismiss.
 *    Never use for the primary action on a modal.
 *
 * 3. TINT-ON-HOVER (transparent, subtle bg tint on hover) — use SPARINGLY.
 *    ghost — icon-only toolbar buttons, copy buttons. Tight spaces only.
 *    nav   — sidebar/navigation only.
 *    Never use ghost/nav for labeled action buttons — use outline instead.
 *
 * SURFACE PROP — name the BACKDROP the button sits on:
 *    surface="primary"   the button sits on the page background (bg-primary).
 *    surface="secondary" the button sits on a card/modal (bg-secondary). DEFAULT.
 *    Outline and ghost derive contrasting chrome from it automatically —
 *    a button can never blend into its own backdrop.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */
// @ts-nocheck
import { Children, useRef, cloneElement, isValidElement } from "react";
import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { useSmoothResize } from "../../hooks/useSmoothResize";
import { haptic } from "../../utils/haptics";

// Minimal Slot implementation — merges props onto the single element child.
// Replaces the radix-ui Slot dependency for the asChild pattern. Tolerates
// `false`/null conditional siblings by picking the first real element.
function Slot({ children, ...props }) {
  const child = Children.toArray(children).find(isValidElement);
  if (!child) return null;
  return cloneElement(child, {
    ...props,
    ...child.props,
    className: cn(props.className, child.props.className),
  });
}

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-pill font-medium motion-safe:transition-all active:motion-safe:scale-95 outline-none no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        // SOLID — surface-aware inversion on hover
        primary: "bg-primary text-secondary hover:bg-accent hover:text-primary hover:scale-105",
        secondary: "bg-secondary text-primary hover:bg-accent hover:text-primary hover:scale-105",
        accent: "bg-accent text-primary hover:bg-primary hover:text-secondary hover:scale-105 ring-2 ring-transparent hover:ring-error/50",
        danger: "bg-error text-secondary hover:text-primary hover:scale-105",
        nav: "bg-transparent text-secondary hover:bg-secondary/10",
        // OUTLINE — transparent, fills on hover (surface-aware via compound variants)
        outline: "bg-transparent border-2 hover:scale-105",
        // TINT-ON-HOVER (surface-aware via compound variants)
        ghost: "bg-transparent",
      },
      size: {
        sm: "px-3 py-1.5 text-xs",
        md: "px-4 py-2 text-sm",
        lg: "px-6 py-3 text-base",
        icon: "p-2",
        iconSm: "p-1.5",
      },
      surface: {
        primary: "focus-visible:ring-offset-primary",
        secondary: "focus-visible:ring-offset-secondary",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
      smoothResize: {
        true: "whitespace-nowrap",
        false: "",
      },
    },
    compoundVariants: [
      // Ghost/outline: `surface` names the BACKDROP the button sits on
      // ("primary" = page bg, "secondary" = card). The chrome is always the
      // contrasting token, so the button can never blend into its backdrop.
      { variant: "ghost", surface: "primary", class: "text-secondary hover:bg-secondary/10" },
      { variant: "ghost", surface: "secondary", class: "text-primary hover:bg-primary/10" },
      // Outline: border/text contrasts with the backdrop; hover inverts.
      { variant: "outline", surface: "primary", class: "border-secondary text-secondary hover:bg-secondary hover:text-primary" },
      { variant: "outline", surface: "secondary", class: "border-primary text-primary hover:bg-primary hover:text-secondary" },
      // Caution/destructive variants share an error focus ring.
      { variant: "accent", surface: "primary", class: "focus-visible:ring-error focus-visible:ring-offset-primary" },
      { variant: "accent", surface: "secondary", class: "focus-visible:ring-error focus-visible:ring-offset-secondary" },
      { variant: "danger", surface: "primary", class: "focus-visible:ring-error focus-visible:ring-offset-primary" },
      { variant: "danger", surface: "secondary", class: "focus-visible:ring-error focus-visible:ring-offset-secondary" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
      surface: "secondary",
      fullWidth: false,
      smoothResize: false,
    },
  }
);

/**
 * @param {{
 *   children?: any, variant?: string, size?: string, loading?: boolean,
 *   disabled?: boolean, type?: "button" | "reset" | "submit", className?: string,
 *   smoothResize?: boolean, fullWidth?: boolean, surface?: "primary"|"secondary",
 *   active?: boolean, asChild?: boolean, [key: string]: any
 * }} props
 */
export default function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  type = "button",
  smoothResize = false,
  fullWidth = false,
  surface = "secondary",
  active = false,
  asChild = false,
  className = "",
  onClick,
  ...props
}) {
  const ref = useRef(null);

  useSmoothResize(ref, { x: smoothResize && !fullWidth });

  const cvaProps = { variant, size, surface, fullWidth, smoothResize };
  const buttonClass = cn(buttonVariants(cvaProps), className);

  // Haptic feedback on every press — caution/destructive actions get a heavier buzz.
  const handleClick = (event) => {
    haptic(variant === "danger" || variant === "accent" ? "error" : "tap");
    onClick?.(event);
  };

  // asChild: style the child element (e.g. a router Link or anchor) as a
  // Button. Button-only attributes (type, disabled) don't apply to links.
  if (asChild) {
    return (
      <Slot
        ref={ref}
        data-slot="button"
        data-surface={surface}
        aria-pressed={active || undefined}
        aria-disabled={disabled || loading || undefined}
        className={buttonClass}
        onClick={handleClick}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      data-surface={surface}
      disabled={disabled || loading}
      aria-pressed={active || undefined}
      className={buttonClass}
      onClick={handleClick}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

Button.propTypes = {
  children: PropTypes.node,
  variant: PropTypes.oneOf(["primary", "secondary", "accent", "danger", "ghost", "outline", "nav"]),
  size: PropTypes.oneOf(["sm", "md", "lg", "icon", "iconSm"]),
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  type: PropTypes.oneOf(["button", "submit", "reset"]),
  smoothResize: PropTypes.bool,
  fullWidth: PropTypes.bool,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  active: PropTypes.bool,
  asChild: PropTypes.bool,
  className: PropTypes.string,
};
