import PropTypes from "prop-types";

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
  className = "",
}) {
  const IconOn = iconOn;
  const IconOff = iconOff;
  const descriptionId = label ? `toggle-desc-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined;

  return (
    <div className={`flex items-center justify-between ${className}`}>
      {(label || description) && (
        <div className="flex-1 min-w-0 pr-4">
          {label && (
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm" style={{ color: "inherit" }}>{label}</span>
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
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-all ease-[var(--motion-easing-emphasized)] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
          checked ? "bg-accent" : "bg-current/20"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        style={{ transitionDuration: "var(--motion-duration-short4)" }}
        role="switch"
        aria-checked={checked}
        aria-label={label || "Toggle"}
        aria-describedby={description ? descriptionId : undefined}
      >
        <span
          className={`inline-flex items-center justify-center h-5 w-5 transform rounded-full bg-current transition-all ease-[var(--motion-easing-emphasized)] ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
          style={{ transitionDuration: "var(--motion-duration-short4)" }}
        >
          {IconOn && checked && <IconOn size={12} className="text-accent" />}
          {IconOff && !checked && <IconOff size={12} className="text-accent" />}
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
  className: PropTypes.string,
};
