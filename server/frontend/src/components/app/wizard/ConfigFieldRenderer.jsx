import { memo } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import Dropdown from "../../common/Dropdown";
import AnimatedCheckbox from "../../ui/AnimatedCheckbox";

function ConfigFieldRenderer({ field, value, onChange, disabled }) {
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState(null);

  const handleChange = (newValue) => {
    if (field.type === "port") {
      const port = parseInt(newValue, 10);
      if (newValue !== "" && (isNaN(port) || port < 1 || port > 65535)) {
        setLocalError("Port must be between 1 and 65535");
      } else {
        setLocalError(null);
      }
    } else if (field.type === "number") {
      if (newValue !== "" && isNaN(parseFloat(newValue))) {
        setLocalError("Please enter a valid number");
      } else {
        setLocalError(null);
      }
    } else {
      setLocalError(null);
    }
    onChange(newValue);
  };

const inputBaseClasses = `
      w-full px-4 py-2 border-2 rounded-large-element
      bg-primary text-secondary
      focus:ring-2 focus:ring-accent focus:ring-offset-2
      motion-safe:transition-all
      disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const errorClasses = localError ? "border-secondary" : "border-secondary/30 focus:border-secondary";

  const renderInput = () => {
    switch (field.type) {
      case "password":
        return (
          <div className="relative">
            <input
              id={field.name}
              type={showPassword ? "text" : "password"}
              value={value ?? ""}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={field.required ? "Required" : "Auto-generated if empty"}
              disabled={disabled}
              className={`${inputBaseClasses} ${errorClasses} pr-11`}
              aria-invalid={Boolean(localError)}
              aria-describedby={localError ? `${field.name}-error` : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-secondary/50 hover:text-secondary motion-safe:transition-colors"
              aria-label={showPassword ? "Hide password" : "Show password"}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        );

      case "boolean":
        return (
          <AnimatedCheckbox
            checked={value ?? field.default ?? false}
            onChange={handleChange}
            className="text-secondary/70"
          >
            {field.description}
          </AnimatedCheckbox>
        );

      case "select":
        return (
          <Dropdown
            value={value ?? field.default ?? ""}
            onChange={handleChange}
            disabled={disabled}
            fullWidth
            options={
              field.options?.length > 0 && field.options[0]?.value !== undefined
                ? field.options.map((option) => ({ value: option.value, label: option.label || option.value }))
                : (field.options || []).map((option) => ({ value: String(option), label: option === "" ? "— None —" : String(option) }))
            }
          />
        );

      case "port":
      case "number":
        return (
          <input
            id={field.name}
            type="number"
            value={value ?? field.default ?? ""}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={field.required ? "Required" : `Default: ${field.default}`}
            disabled={disabled}
            min={field.type === "port" ? 1 : undefined}
            max={field.type === "port" ? 65535 : undefined}
            className={`${inputBaseClasses} ${errorClasses}`}
            aria-invalid={Boolean(localError)}
            aria-describedby={localError ? `${field.name}-error` : undefined}
          />
        );

      case "string":
      default:
        return (
          <input
            id={field.name}
            type="text"
            value={value ?? ""}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={field.required ? "Required" : `Default: ${field.default ?? "None"}`}
            disabled={disabled}
            className={`${inputBaseClasses} ${errorClasses}`}
          />
        );
    }
  };

  return (
    <div className="space-y-1">
      {field.type !== "boolean" && (
        <label
          htmlFor={field.name}
          className="block font-mono text-sm text-secondary"
        >
          {field.label}
          {field.required && <span className="text-secondary ml-1">*</span>}
        </label>
      )}

      {field.type !== "boolean" && field.description && (
        <p className="text-xs text-secondary/50">{field.description}</p>
      )}

      {renderInput()}

      {localError && (
        <p id={`${field.name}-error`} className="text-xs text-secondary mt-1">
          {localError}
        </p>
      )}
    </div>
  );
}

export default memo(ConfigFieldRenderer);
