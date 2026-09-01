import { cn } from "@/lib/utils";
import { memo } from "react";
import PropTypes from "prop-types";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import Dropdown from "../../common/Dropdown";
import AnimatedCheckbox from "../../ui/AnimatedCheckbox";
import FieldLabel from "../../common/forms/FieldLabel";

/** @param {{ field: any, value: any, onChange: any, disabled?: any, surface?: "primary"|"secondary" }} _ */
function ConfigFieldRenderer({ field, value, onChange, disabled, surface = "secondary" }) {
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState(null);

  const textColor = surface === "secondary" ? "text-primary" : "text-secondary";
  const mutedTextColor = surface === "secondary" ? "text-primary/70" : "text-secondary/70";

  const handleChange = (newValue) => {
    if (field.type === "port") {
      const port = parseInt(newValue, 10);
      if (newValue !== "" && (isNaN(port) || port < 1 || port > 65535)) {
        setLocalError("Port must be between 1 and 65535");
      } else {
        setLocalError(null);
      }
      onChange(newValue === "" ? "" : port);
    } else if (field.type === "number") {
      const num = parseFloat(newValue);
      if (newValue !== "" && isNaN(num)) {
        setLocalError("Please enter a valid number");
      } else {
        setLocalError(null);
      }
      onChange(newValue === "" ? "" : num);
    } else {
      setLocalError(null);
      onChange(newValue);
    }
  };

const inputBaseClasses = `
      w-full px-5 py-2 border-2 rounded-large-element
      bg-secondary text-primary outline-none
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
              className={cn(inputBaseClasses, errorClasses, "pr-11")}
              aria-invalid={Boolean(localError)}
              aria-describedby={localError ? `${field.name}-error` : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className={cn("absolute right-3 top-1/2 -translate-y-1/2 p-1 motion-safe:transition-colors", `${mutedTextColor} hover:${textColor}`)}
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
            className={mutedTextColor}
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
            bg={surface === "secondary" ? "primary" : "secondary"}
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
            className={cn(inputBaseClasses, errorClasses)}
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
            className={cn(inputBaseClasses, errorClasses)}
          />
        );
    }
  };

  return (
    <div className={cn("space-y-1")} data-slot="config-field-renderer">
      {field.type !== "boolean" && (
        <FieldLabel htmlFor={field.name} surface={surface} required={field.required}>
          {field.label}
        </FieldLabel>
      )}

      {field.type !== "boolean" && field.description && (
        <p className={cn("text-xs translate-x-5", mutedTextColor)}>{field.description}</p>
      )}

      {renderInput()}

      {localError && (
        <p id={`${field.name}-error`} className={cn("text-xs", textColor, "mt-1")}>
          {localError}
        </p>
      )}
    </div>
  );
}

ConfigFieldRenderer.propTypes = {
  field: PropTypes.object,
  value: PropTypes.any,
  onChange: PropTypes.func,
  disabled: PropTypes.bool,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};

export default memo(ConfigFieldRenderer);
