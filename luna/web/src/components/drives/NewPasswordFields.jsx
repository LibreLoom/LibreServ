import PropTypes from "prop-types";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import FormInput from "../common/forms/FormInput.jsx";

/**
 * The new password, asked for twice. Used wherever a
 * drive's password is chosen: Protect, Change password, and the Add-drive
 * hand-off. The caller owns the values (they are never stored anywhere else)
 * and checks them with `newPasswordProblem` before going on. The live strength
 * chips make the rules visible while the password is being typed.
 *
 * @param {{
 *   idPrefix: string,
 *   password: string,
 *   again: string,
 *   onPassword: (value: string) => void,
 *   onAgain: (value: string) => void,
 *   label?: string,
 *   error?: string,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function NewPasswordFields({ idPrefix, password, again, onPassword, onAgain, label = "Password", error = "", surface = "secondary" }) {
  return (
    <div>
      <FormInput
        label={label}
        name={`${idPrefix}-new`}
        type="password"
        icon="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        surface={surface}
        className="mb-4"
      />
      <PasswordStrengthChecklist password={password} surface={surface} className="mb-3" />
      <FormInput
        label={`${label}, once more`}
        name={`${idPrefix}-again`}
        type="password"
        icon="password"
        autoComplete="new-password"
        value={again}
        onChange={(e) => onAgain(e.target.value)}
        error={error}
        surface={surface}
        className="mb-0"
      />
    </div>
  );
}

NewPasswordFields.propTypes = {
  idPrefix: PropTypes.string.isRequired,
  password: PropTypes.string.isRequired,
  again: PropTypes.string.isRequired,
  onPassword: PropTypes.func.isRequired,
  onAgain: PropTypes.func.isRequired,
  label: PropTypes.string,
  error: PropTypes.string,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
