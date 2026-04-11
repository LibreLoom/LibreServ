import PropTypes from "prop-types";
import { useMemo } from "react";

export default function PasswordStrengthIndicator({ password, className = "" }) {
  const strength = useMemo(() => {
    if (!password) return { score: 0, label: "", color: "" };

    let score = 0;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;

    if (score <= 2) return { score, label: "Weak", color: "bg-error" };
    if (score <= 3) return { score, label: "Fair", color: "bg-warning" };
    if (score <= 4) return { score, label: "Good", color: "bg-success" };
    return { score, label: "Strong", color: "bg-success" };
  }, [password]);

  if (!password) return null;

  return (
    <div className={`mt-2 px-5 ${className}`} role="status" aria-live="polite">
      <span className="sr-only">Password strength: {strength.label}</span>
      <div className="flex gap-1 mb-1" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full motion-safe:transition-colors ${
              i <= strength.score ? strength.color : "bg-primary/20"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-primary/60" aria-hidden="true">{strength.label}</p>
    </div>
  );
}

PasswordStrengthIndicator.propTypes = {
  password: PropTypes.string,
  className: PropTypes.string,
};
