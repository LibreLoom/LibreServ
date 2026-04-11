import PropTypes from "prop-types";

export default function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  iconOn,
  iconOff,
  className = "",
}) {
  const IconOn = iconOn;
  const IconOff = iconOff;
  const descriptionId = label ? `toggle-desc-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined;

  return (
    <div className={`flex items-center justify-between ${className}`}>
      {(label || description) && (
        <div className="flex-1 min-w-0 pr-4">
          {label && <div className="font-medium text-primary text-sm">{label}</div>}
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
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-all ease-[var(--motion-easing-emphasized)] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary ${
          checked ? "bg-accent" : "bg-primary/20"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        style={{ transitionDuration: "var(--motion-duration-short4)" }}
        role="switch"
        aria-checked={checked}
        aria-label={label || "Toggle"}
        aria-describedby={description ? descriptionId : undefined}
      >
        <span
          className={`inline-flex items-center justify-center h-5 w-5 transform rounded-full bg-primary transition-all ease-[var(--motion-easing-emphasized)] ${
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
  className: PropTypes.string,
};
