import { Check, X } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { passwordChecks } from "../../lib/passwordPolicy";

const STRENGTH_LABEL = ["", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLOR = ["", "bg-error", "bg-warning", "bg-warning", "bg-success"];
const STRENGTH_TEXT = ["", "text-error", "text-warning", "text-warning", "text-success"];

/** @param {{ ok: boolean, label: string, size?: "md"|"sm", surface?: "secondary"|"primary" }} props */
function ReqChip({ ok, label, size = "md", surface = "secondary" }) {
  const iconClass = size === "sm" ? "w-2.5 h-2.5" : "w-3 h-3";
  const unmet =
    surface === "primary" ? "text-secondary/50" : "text-accent";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono motion-safe:transition-colors motion-safe:duration-200",
        size === "sm" ? "text-[11px]" : "text-xs",
        ok ? "text-success" : unmet,
      )}
    >
      {ok ? <Check className={iconClass} aria-hidden="true" /> : <X className={iconClass} aria-hidden="true" />}
      {label}
    </span>
  );
}
ReqChip.propTypes = {
  ok: PropTypes.bool.isRequired,
  label: PropTypes.string.isRequired,
  size: PropTypes.oneOf(["md", "sm"]),
  surface: PropTypes.oneOf(["secondary", "primary"]),
};

/** @param {{ score: number, size?: "md"|"sm", surface?: "secondary"|"primary" }} props */
function PasswordStrengthBar({ score, size = "md", surface = "secondary" }) {
  const empty = surface === "primary" ? "bg-secondary/20" : "bg-primary/15";
  return (
    <div className={cn("flex gap-1", size === "sm" ? "mt-1.5" : "mt-2.5")} aria-hidden="true">
      {[1, 2, 3, 4].map((lvl) => (
        <div
          key={lvl}
          className={cn(
            "flex-1 rounded-full motion-safe:transition-all motion-safe:duration-300",
            size === "sm" ? "h-0.5" : "h-1",
            lvl <= score ? STRENGTH_COLOR[score] : empty,
          )}
        />
      ))}
    </div>
  );
}
PasswordStrengthBar.propTypes = {
  score: PropTypes.number.isRequired,
  size: PropTypes.oneOf(["md", "sm"]),
  surface: PropTypes.oneOf(["secondary", "primary"]),
};

/**
 * Live password strength bar + requirement chips.
 * Same rules/copy as setup; pass `size="sm"` for modals and compact forms.
 * `surface` names the backdrop: secondary = card/modal, primary = page/inverted form.
 *
 * @param {{
 *   password: string,
 *   size?: "md"|"sm",
 *   surface?: "secondary"|"primary",
 *   className?: string,
 * }} props
 */
export default function PasswordStrengthChecklist({
  password,
  size = "md",
  surface = "secondary",
  className,
}) {
  if (!password) return null;

  const strength = passwordChecks(password);
  const meetsPolicy = strength.ok;
  const pendingTone = surface === "primary" ? "text-secondary" : "text-accent";

  return (
    <div
      className={cn(size === "sm" ? "mt-2 px-1" : "mt-1", className)}
      data-slot="password-strength-checklist"
      data-size={size}
      aria-live="polite"
    >
      <PasswordStrengthBar score={strength.score} size={size} surface={surface} />
      <div className={cn("flex items-center justify-between", size === "sm" ? "mt-1" : "mt-1.5")}>
        <p className={cn("font-mono", size === "sm" ? "text-[11px]" : "text-xs", STRENGTH_TEXT[strength.score])}>
          {STRENGTH_LABEL[strength.score]}
        </p>
        <p
          className={cn(
            "font-mono",
            size === "sm" ? "text-[11px]" : "text-xs",
            meetsPolicy ? "text-success" : pendingTone,
          )}
        >
          {meetsPolicy ? "✓ Acceptable" : "Not strong enough yet"}
        </p>
      </div>
      <div className={cn("flex flex-wrap gap-x-3 gap-y-1", size === "sm" ? "mt-1.5" : "mt-2")}>
        <ReqChip ok={strength.hasLength} label="12+ chars" size={size} surface={surface} />
        <ReqChip ok={strength.hasLetter} label="letters" size={size} surface={surface} />
        <ReqChip ok={strength.hasDigit} label="numbers" size={size} surface={surface} />
        <ReqChip ok={strength.hasSpecial} label="symbols" size={size} surface={surface} />
      </div>
    </div>
  );
}

PasswordStrengthChecklist.propTypes = {
  password: PropTypes.string,
  size: PropTypes.oneOf(["md", "sm"]),
  surface: PropTypes.oneOf(["secondary", "primary"]),
  className: PropTypes.string,
};
