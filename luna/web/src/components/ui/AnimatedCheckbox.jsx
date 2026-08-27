import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics.js";

/**
 * Round checkmark control used across LibreLoom UIs.
 * Prefer this over a native `<input type="checkbox">`.
 *
 * @param {{
 *   checked: boolean,
 *   onChange: (checked: boolean, event?: import("react").ChangeEvent<HTMLInputElement>) => void,
 *   children?: import("react").ReactNode,
 *   "aria-label"?: string,
 *   className?: string,
 *   surface?: "primary" | "secondary",
 *   disabled?: boolean,
 * }} props
 */
export default function AnimatedCheckbox({
  checked,
  onChange,
  children,
  "aria-label": ariaLabel,
  className = "",
  surface = "secondary",
  disabled = false,
}) {
  const uncheckedBorder =
    surface === "primary"
      ? "border-secondary/50 group-hover:border-secondary"
      : "border-primary/50 group-hover:border-primary";

  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 cursor-pointer group",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      data-slot="animated-checkbox"
    >
      <span
        className={cn(
          "size-5 rounded-full border-2 flex items-center justify-center motion-safe:transition-all duration-200 shrink-0",
          checked ? "border-accent bg-accent" : uncheckedBorder,
        )}
        aria-hidden="true"
      >
        <svg
          className={cn(
            "size-3 text-primary motion-safe:transition-all duration-200",
            checked ? "scale-100 opacity-100" : "scale-0 opacity-0",
          )}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          if (disabled) return;
          haptic("tap");
          onChange(e.target.checked, e);
        }}
        onClick={(e) => e.stopPropagation()}
        className="sr-only"
      />
      {children ? (
        <span className="text-sm font-medium leading-relaxed">{children}</span>
      ) : null}
    </label>
  );
}

AnimatedCheckbox.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  children: PropTypes.node,
  "aria-label": PropTypes.string,
  className: PropTypes.string,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  disabled: PropTypes.bool,
};
