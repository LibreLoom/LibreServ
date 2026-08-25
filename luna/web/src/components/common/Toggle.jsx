import PropTypes from "prop-types";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics";

const toggleTrackVariants = cva(
  "relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-all ease-[var(--motion-easing-emphasized)] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:scale-95",
  {
    variants: {
      checked: {
        true: "bg-accent",
        false: "bg-current/20",
      },
      disabled: {
        true: "opacity-50 cursor-not-allowed",
        false: "cursor-pointer",
      },
    },
    defaultVariants: {
      checked: false,
      disabled: false,
    },
  }
);

/**
 * @typedef {object} ToggleProps
 * @property {boolean} checked
 * @property {(checked: boolean) => void} onChange
 * @property {string} [label]
 * @property {string} [description]
 * @property {boolean} [disabled]
 * @property {import('react').ElementType} [iconOn]
 * @property {import('react').ElementType} [iconOff]
 * @property {import('react').ReactNode} [badge]
 * @property {"primary"|"secondary"} [surface]
 * @property {string} [className]
 */

/** @param {ToggleProps} props */
export default function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  iconOn,
  iconOff,
  badge,
  surface = "secondary",
  className = "",
}) {
  const IconOn = iconOn;
  const IconOff = iconOff;
  const descriptionId = label ? `toggle-desc-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined;
  const labelText = surface === "primary" ? "text-secondary" : "text-primary";

  return (
    <div className={cn("flex items-center justify-between", className)}>
      {(label || description) && (
        <div className="flex-1 min-w-0 pr-4">
          {label && (
            <div className="flex items-center gap-2">
              <span className={cn("font-medium text-sm", labelText)}>{label}</span>
              {badge}
            </div>
          )}
          {description && (
            <div id={descriptionId} className="text-sm text-accent mt-0.5">
              {description}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-slot="switch"
        onClick={() => {
          haptic("light");
          onChange(!checked);
        }}
        disabled={disabled}
        className={cn(toggleTrackVariants({ checked, disabled }))}
        style={{ transitionDuration: "var(--motion-duration-short4)" }}
        role="switch"
        aria-checked={checked}
        aria-label={label || "Toggle"}
        aria-describedby={description ? descriptionId : undefined}
      >
        <span
          data-slot="switch-thumb"
          className={cn(
            "inline-flex h-5 w-5 transform items-center justify-center rounded-full bg-current",
            "transition-transform ease-[var(--motion-easing-spring)] will-change-transform",
            checked ? "translate-x-6" : "translate-x-1"
          )}
          style={{ transitionDuration: "var(--motion-duration-medium3)" }}
        >
          <span
            key={checked ? "on" : "off"}
            className="flex h-full w-full items-center justify-center animate-toggle-settle"
          >
            {IconOn && checked && <IconOn size={12} className="text-accent" />}
            {IconOff && !checked && <IconOff size={12} className="text-accent" />}
          </span>
        </span>
      </button>
    </div>
  );
}

Toggle.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string,
  description: PropTypes.string,
  disabled: PropTypes.bool,
  iconOn: PropTypes.elementType,
  iconOff: PropTypes.elementType,
  badge: PropTypes.node,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  className: PropTypes.string,
};
