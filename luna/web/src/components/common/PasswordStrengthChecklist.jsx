import { Check, X } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { passwordChecks } from "../../lib/passwordPolicy";

const STRENGTH_LABEL = ["", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLOR = ["", "bg-error", "bg-warning", "bg-warning", "bg-success"];
const STRENGTH_TEXT = ["", "text-error", "text-warning", "text-warning", "text-success"];

/** @param {{ ok: boolean, label: string }} props */
function ReqChip({ ok, label }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs motion-safe:transition-colors motion-safe:duration-200",
        ok ? "text-success" : "text-primary/50",
      )}
    >
      {ok ? <Check className="w-3 h-3" aria-hidden="true" /> : <X className="w-3 h-3" aria-hidden="true" />}
      {label}
    </span>
  );
}
ReqChip.propTypes = {
  ok: PropTypes.bool.isRequired,
  label: PropTypes.string.isRequired,
};

/** @param {{ score: number }} props */
function PasswordStrengthBar({ score }) {
  return (
    <div className="mt-2.5 flex gap-1" aria-hidden="true">
      {[1, 2, 3, 4].map((lvl) => (
        <div
          key={lvl}
          className={cn(
            "h-1 flex-1 rounded-full motion-safe:transition-all motion-safe:duration-300",
            lvl <= score ? STRENGTH_COLOR[score] : "bg-primary/15",
          )}
        />
      ))}
    </div>
  );
}
PasswordStrengthBar.propTypes = {
  score: PropTypes.number.isRequired,
};

/**
 * Live password strength bar + requirement chips (full-size, same as setup).
 *
 * @param {{
 *   password: string,
 *   className?: string,
 * }} props
 */
export default function PasswordStrengthChecklist({ password, className }) {
  if (!password) return null;

  const strength = passwordChecks(password);
  const meetsPolicy = strength.ok;

  return (
    <div
      className={cn("mt-3", className)}
      data-slot="password-strength-checklist"
      aria-live="polite"
    >
      <PasswordStrengthBar score={strength.score} />
      <div className="mt-1.5 flex items-center justify-between">
        <p className={cn("font-mono text-xs", STRENGTH_TEXT[strength.score])}>
          {STRENGTH_LABEL[strength.score]}
        </p>
        <p className={cn("font-mono text-xs", meetsPolicy ? "text-success" : "text-primary")}>
          {meetsPolicy ? "✓ Acceptable" : "Not strong enough yet"}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        <ReqChip ok={strength.hasLength} label="12+ chars" />
        <ReqChip ok={strength.hasLetter} label="letters" />
        <ReqChip ok={strength.hasDigit} label="numbers" />
        <ReqChip ok={strength.hasSpecial} label="symbols" />
      </div>
    </div>
  );
}

PasswordStrengthChecklist.propTypes = {
  password: PropTypes.string,
  className: PropTypes.string,
};
