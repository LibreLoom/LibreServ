import PropTypes from "prop-types";
import Dropdown from "../common/Dropdown";

export default function Select({
  label,
  description,
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className = "",
}) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      {(label || description) && (
        <div className="flex-1 min-w-0 pr-4">
          {label && (
            <label className="font-medium text-primary text-sm cursor-pointer">
              {label}
            </label>
          )}
          {description && (
            <div className="text-sm text-accent mt-0.5">{description}</div>
          )}
        </div>
      )}
      <div className="flex-shrink-0">
        <Dropdown
          value={value}
          onChange={onChange}
          options={options}
          placeholder={placeholder}
          disabled={disabled}
          label={label}
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
