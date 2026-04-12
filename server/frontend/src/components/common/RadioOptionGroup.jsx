import PropTypes from "prop-types";

export default function RadioOptionGroup({
  name,
  options,
  value,
  onChange,
  className = "",
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      {options.map((opt) => {
        const isSelected = value === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex items-center gap-3 p-2.5 rounded-large-element border cursor-pointer transition-all duration-200 ${
              isSelected
                ? "border-accent bg-accent/10"
                : "border-primary/10 hover:bg-primary/5"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={isSelected}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <div
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                isSelected ? "border-accent bg-accent" : "border-accent/40"
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full bg-primary transition-all duration-200 ${
                  isSelected ? "scale-100 opacity-100" : "scale-0 opacity-0"
                }`}
              />
            </div>
            <div className="flex-1">
              <div className="font-medium text-primary text-sm">{opt.label}</div>
              {opt.description && (
                <div className="text-xs text-accent">{opt.description}</div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}

RadioOptionGroup.propTypes = {
  name: PropTypes.string.isRequired,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      description: PropTypes.string,
    })
  ).isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  className: PropTypes.string,
};
