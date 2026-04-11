import PropTypes from "prop-types";
import { useId } from "react";

export default function RadioGroup({
  label,
  description,
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}) {
  const groupId = useId();
  return (
    <div className={className}>
      {label && <div className="font-medium text-primary text-sm mb-2">{label}</div>}
      {description && (
        <div className="text-sm text-accent mb-3">{description}</div>
      )}
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`inline-flex items-center gap-2 cursor-pointer ${
              disabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            <input
              type="radio"
              name={groupId}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              disabled={disabled}
              className="sr-only peer"
            />
            <span
              className={`w-4 h-4 rounded-full border-2 motion-safe:transition-all flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                value === opt.value
                  ? "border-accent bg-accent"
                  : "border-primary/30 bg-primary"
              }`}
            >
              {value === opt.value && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </span>
            <span className="text-sm text-primary">{opt.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

RadioGroup.propTypes = {
  label: PropTypes.string,
  description: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  onChange: PropTypes.func.isRequired,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.string.isRequired,
    })
  ).isRequired,
  disabled: PropTypes.bool,
  className: PropTypes.string,
};
