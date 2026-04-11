import PropTypes from "prop-types";
import { ChevronDown } from "lucide-react";

export default function Select({
  label,
  description,
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className = "",
  id,
}) {
  const selectId = id || (label ? `select-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);

  return (
    <div className={`flex items-center justify-between ${className}`}>
      {(label || description) && (
        <div className="flex-1 min-w-0 pr-4">
          {label && (
            <label htmlFor={selectId} className="font-medium text-primary text-sm cursor-pointer">
              {label}
            </label>
          )}
          {description && (
            <div className="text-sm text-accent mt-0.5">{description}</div>
          )}
        </div>
      )}
      <div className="relative flex-shrink-0">
        <select
          id={selectId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={label}
          className={`appearance-none bg-primary text-secondary text-sm font-mono px-4 py-1.5 pr-8 border-2 border-primary/20 rounded-pill cursor-pointer motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary focus-visible:border-accent ${
            disabled ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-accent pointer-events-none"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

Select.propTypes = {
  label: PropTypes.string,
  description: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func.isRequired,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.string.isRequired,
    })
  ).isRequired,
  placeholder: PropTypes.string,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  id: PropTypes.string,
};
