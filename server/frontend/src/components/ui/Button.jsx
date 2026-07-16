/**
 * Button — the canonical button primitive, built on shadcn/ui architecture.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONVENTION — when to use each variant
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. SOLID (full color change on hover) — the default. Use for actions.
 *    primary   — page-bg fill. Hover → accent (gray). Use on CARDS only.
 *                The single most important action on a card surface.
 *    secondary — card-bg fill. Hover → accent (gray). Use on the PAGE only.
 *                The primary action when rendered directly on the page bg.
 *    accent    — gray fill. Hover → surface-aware invert. Works ANYWHERE.
 *                Submit/save buttons in forms, modals, cards. The workhorse.
 *    danger    — red fill. Hover → accent (gray). Destructive actions ONLY.
 *                "Delete", "Uninstall", "Factory Reset".
 *
 *    Why primary/secondary are surface-restricted: their bg is a surface color,
 *    so they only contrast on the OPPOSITE surface. Their hover goes to accent
 *    (gray) which contrasts with both surfaces, so the button never vanishes.
 *
 * 2. OUTLINE (transparent, fills on hover) — medium emphasis.
 *    Use for secondary actions, especially Cancel/Back/Dismiss.
 *    Never use for the primary action on a modal.
 *
 * 3. TINT-ON-HOVER (transparent, subtle bg tint on hover) — use SPARINGLY.
 *    ghost — icon-only toolbar buttons, copy buttons. Tight spaces only.
 *    nav   — sidebar/navigation only.
 *    Never use ghost/nav for labeled action buttons — use outline instead.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */
// @ts-nocheck
import { useRef, cloneElement, isValidElement } from "react";
import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { useSmoothResize } from "../../hooks/useSmoothResize";

// Minimal Slot implementation — merges props onto a single child element.
// Replaces the radix-ui Slot dependency for the asChild pattern.
function Slot({ children, ...props }) {
  if (isValidElement(children)) {
    return cloneElement(children, {
      ...props,
      ...children.props,
      className: cn(props.className, children.props.className),
    });
  }
  return null;
}

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-pill font-medium motion-safe:transition-all active:motion-safe:scale-95 no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        // SOLID — surface-aware inversion on hover
        primary: "bg-primary text-secondary hover:bg-accent hover:text-primary hover:ring-2 hover:ring-primary",
        secondary: "bg-secondary text-primary hover:bg-accent hover:text-primary hover:ring-2 hover:ring-accent",
        accent: "bg-accent text-primary hover:bg-primary hover:text-secondary hover:ring-2 hover:ring-primary",
        danger: "bg-error text-secondary hover:bg-accent hover:text-primary hover:ring-2 hover:ring-error",
        nav: "bg-transparent text-secondary hover:bg-secondary/10",
        // OUTLINE — transparent, fills on hover (surface-aware via compound variants)
        outline: "bg-transparent border-2 hover:ring-2",
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
      // Ghost: surface-aware text
      { variant: "ghost", surface: "primary", class: "text-primary hover:bg-primary/10" },
      { variant: "ghost", surface: "secondary", class: "text-secondary hover:bg-secondary/10" },
      // Outline: surface-aware border/text
      { variant: "outline", surface: "primary", class: "border-primary text-primary hover:bg-primary hover:text-secondary" },
      { variant: "outline", surface: "secondary", class: "border-secondary text-secondary hover:bg-secondary hover:text-primary" },
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
  ...props
}) {
  const ref = useRef(null);

  useSmoothResize(ref, { x: smoothResize && !fullWidth });

  const Comp = asChild ? Slot.Root : "button";
  const cvaProps = { variant, size, surface, fullWidth, smoothResize };
  const buttonClass = cn(buttonVariants(cvaProps), className);

  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      data-slot="button"
      data-surface={surface}
      disabled={disabled || loading}
      aria-pressed={active || undefined}
      className={buttonClass}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </Comp>
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
