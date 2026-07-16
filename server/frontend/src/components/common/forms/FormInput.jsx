import { User, Lock, Mail, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import FieldLabel from "./FieldLabel";

const ICONS = {
  username: User,
  password: Lock,
  email: Mail,
};

/**
 * @param {{ label?: any, name: any, type?: string, value: any, onChange: any, placeholder?: any, error?: any, icon?: any, required?: boolean, disabled?: boolean, autoComplete?: any, minLength?: number, surface?: "primary"|"secondary" }} _
 */
export default function FormInput({
  label,
  name,
  type = "text",
  value,
  onChange,
  placeholder,
  error,
  icon,
  required = false,
  disabled = false,
  autoComplete,
  minLength,
  surface = "secondary",
}) {
  const [showPassword, setShowPassword] = useState(false);
  const Icon = icon ? ICONS[icon] : null;
  const isPassword = type === "password";

  return (
    <div className="mb-4">
      {label && (
        <FieldLabel htmlFor={name} surface={surface} required={required} className="mb-1">
          {label}
        </FieldLabel>
      )}
      <div className="relative">
        {Icon && (
          <Icon
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
          />
        )}
        <input
          data-slot="input"
          id={name}
          name={name}
          type={isPassword && showPassword ? "text" : type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          minLength={minLength}
          aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : undefined}
          className={cn(
            "w-full py-2 border-2 rounded-pill no-focus-outline",
            "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
            "bg-secondary text-primary placeholder:text-primary/40 disabled:opacity-50 disabled:cursor-not-allowed",
            Icon ? "pl-11" : "pl-5",
            "pr-11",
            error ? "border-error" : "border-primary/30 focus-visible:border-accent"
          )}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary no-focus-outline rounded-pill p-1"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {error && (
        <p id={`${name}-error`} className="text-error text-xs mt-1 px-5 animate-fade-in-up">
          {error}
        </p>
      )}
    </div>
  );
}
