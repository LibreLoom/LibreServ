import PropTypes from "prop-types";
import { useState, useRef } from "react";

const validateHex = (hex) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex);

const normalizeHex = (hex) => {
  if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
};

export default function ColorInput({
  label,
  value,
  onChange,
  description,
  disabled = false,
  className = "",
}) {
  const [inputValue, setInputValue] = useState(value || "#000000");
  const [isValid, setIsValid] = useState(true);
  const lastExternalValue = useRef(value);

  if (value !== lastExternalValue.current) {
    lastExternalValue.current = value;
    setInputValue(value || "#000000");
    setIsValid(true);
  }

  const handleTextChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    if (validateHex(newValue)) {
      setIsValid(true);
      onChange(normalizeHex(newValue));
    } else {
      setIsValid(false);
    }
  };

  const handlePickerChange = (e) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsValid(true);
    onChange(newValue);
  };

  return (
    <div className={`flex items-center justify-between py-2 ${className}`}>
      <div className="flex-1 min-w-0 pr-4">
        <div className="font-medium text-primary text-sm">{label}</div>
        {description && (
          <div className="text-sm text-accent mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={handlePickerChange}
          disabled={disabled}
          className="w-8 h-8 rounded-large-element cursor-pointer border-2 border-primary/20 bg-transparent"
          aria-label={`Choose ${label} color`}
        />
        <input
          type="text"
          value={inputValue}
          onChange={handleTextChange}
          disabled={disabled}
          placeholder="#000000"
          className={`w-20 px-2 py-1 text-xs font-mono border-2 rounded-pill motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary ${
            isValid
              ? "border-primary/20 focus-visible:border-accent"
              : "border-error focus-visible:border-error"
          } bg-secondary text-primary`}
          aria-label={`${label} hex value`}
        />
      </div>
    </div>
  );
}

ColorInput.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  description: PropTypes.string,
  disabled: PropTypes.bool,
  className: PropTypes.string,
};
