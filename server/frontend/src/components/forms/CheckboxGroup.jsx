import PropTypes from "prop-types";

export default function CheckboxGroup({
  label,
  description,
  items,
  values,
  onChange,
  disabled = false,
  className = "",
}) {
  const handleChange = (itemValue, checked) => {
    const next = checked
      ? [...values, itemValue]
      : values.filter((v) => v !== itemValue);
    onChange(next);
  };

  return (
    <div className={className}>
      {label && <div className="font-medium text-primary text-sm mb-2">{label}</div>}
      {description && (
        <div className="text-sm text-accent mb-3">{description}</div>
      )}
      <div className="space-y-2" role="group" aria-label={label}>
        {items.map((item) => {
          const checked = values.includes(item.value);
          return (
            <label
              key={item.value}
              className={`inline-flex items-center gap-2 cursor-pointer ${
                disabled ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => handleChange(item.value, e.target.checked)}
                disabled={disabled}
                className="sr-only peer"
              />
              <span
                className={`w-4 h-4 rounded-card border-2 motion-safe:transition-all flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                  checked
                    ? "border-accent bg-accent"
                    : "border-primary/30 bg-primary"
                }`}
              >
                {checked && (
                  <svg
                    viewBox="0 0 12 12"
                    className="w-2.5 h-2.5 text-primary"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </span>
              <span className="text-sm text-primary">{item.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

CheckboxGroup.propTypes = {
  label: PropTypes.string,
  description: PropTypes.string,
  items: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    })
  ).isRequired,
  values: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  className: PropTypes.string,
};
