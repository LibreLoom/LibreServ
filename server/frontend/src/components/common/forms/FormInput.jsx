import { User, Lock, Mail, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

const ICONS = {
  username: User,
  password: Lock,
  email: Mail,
};

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
}) {
  const [showPassword, setShowPassword] = useState(false);
  const Icon = icon ? ICONS[icon] : null;
  const isPassword = type === "password";

  return (
    <div className="mb-4">
      {label && (
        <label
          htmlFor={name}
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          {label}
          {required && <span className="text-error ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {Icon && (
          <Icon
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
          />
        )}
        <input
          id={name}
          name={name}
          type={isPassword && showPassword ? "text" : type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : undefined}
          className={`w-full pl-11 pr-11 py-2 border-2 rounded-pill focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 ${
            error ? "border-accent" : "border-primary/30 focus:border-accent"
          } bg-secondary text-primary placeholder:text-primary/40 disabled:opacity-50 disabled:cursor-not-allowed`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-pill p-1"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {error && (
        <p id={`${name}-error`} className="text-accent text-xs mt-1 px-5">
          {error}
        </p>
      )}
    </div>
  );
}
