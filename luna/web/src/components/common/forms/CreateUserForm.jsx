/* eslint-disable react-refresh/only-export-components -- mapCreateUserApiError shared with tests */
import { useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import FormInput from "./FormInput";
import Dropdown from "../Dropdown";
import Button from "../../ui/Button";
import ModalErrorNotice from "../ModalErrorNotice";
import { InfoHint } from "../../ui/Tooltip";
import { haptic } from "../../../utils/haptics.js";
import PasswordStrengthChecklist from "../PasswordStrengthChecklist";
import {
  PASSWORD_FIELD_PLACEHOLDER,
  meetsPasswordPolicy,
  passwordPolicyError,
} from "../../../lib/passwordPolicy";
import {
  USERNAME_POLICY_HINT,
  isValidUsername,
} from "../../../lib/usernamePolicy";

/**
 * Map Luna API error copy onto the field that needs fixing (LibreServ AddUserForm pattern).
 * @param {string} message
 * @returns {Record<string, string>}
 */
export function mapCreateUserApiError(message) {
  const raw = String(message || "").trim();
  if (!raw) return { form: "Couldn't add this user. Try again." };
  const lower = raw.toLowerCase();
  if (lower.includes("username") && (lower.includes("taken") || lower.includes("already"))) {
    return { username: raw };
  }
  if (lower.includes("password")) {
    return { password: raw };
  }
  if (lower.includes("username")) {
    return { username: raw };
  }
  return { form: raw };
}

/**
 * LibreServ AddUserForm UX adapted for Luna (display name + Member/Admin, modal submit).
 *
 * @param {{
 *   onSubmit: (body: { username: string, display_name: string, password: string, role: string }) => void,
 *   busy?: boolean,
 *   submitError?: string | null,
 *   onCancel?: () => void,
 *   resetKey?: unknown,
 * }} props
 */
export default function CreateUserForm({
  onSubmit,
  busy = false,
  submitError = null,
  onCancel,
  resetKey,
}) {
  const [formData, setFormData] = useState({
    displayName: "",
    username: "",
    password: "",
    role: "user",
  });
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset draft when parent bumps resetKey (modal reopen)
    setFormData({ displayName: "", username: "", password: "", role: "user" });
    setErrors({});
  }, [resetKey]);

  useEffect(() => {
    if (!submitError) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- map API submitError onto field errors
    setErrors((prev) => ({ ...prev, ...mapCreateUserApiError(submitError) }));
  }, [submitError]);

  const handleChange = useCallback(
    (field) => (e) => {
      const value = e.target.value;
      setFormData((prev) => ({ ...prev, [field]: value }));
      setErrors((prev) => ({ ...prev, [field]: "", form: "" }));
    },
    [],
  );

  const validateForm = useCallback(() => {
    const next = {};
    const username = formData.username.trim();
    if (!username) {
      next.username = "Enter a username.";
    } else if (!isValidUsername(username)) {
      next.username = USERNAME_POLICY_HINT;
    }
    if (!meetsPasswordPolicy(formData.password)) {
      next.password = passwordPolicyError(formData.password) || "Choose a stronger password.";
    }
    return next;
  }, [formData]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const validationErrors = validateForm();
      if (Object.keys(validationErrors).length > 0) {
        haptic("error");
        setErrors(/** @type {any} */ (validationErrors));
        return;
      }
      setErrors({});
      const username = formData.username.trim();
      onSubmit({
        username,
        display_name: formData.displayName.trim() || username,
        password: formData.password,
        role: formData.role,
      });
    },
    [formData, onSubmit, validateForm],
  );

  // Live unmet requirements are shown by the checklist. Hide the duplicate
  // policy string under the field so the modal height stays stable while typing.
  const policyMessage = passwordPolicyError(formData.password);
  const hidePolicyErrorUnderField =
    formData.password.length > 0 &&
    Boolean(errors.password) &&
    (errors.password === policyMessage || errors.password === "Choose a stronger password.");
  const passwordDisplayError = hidePolicyErrorUnderField ? null : errors.password || null;

  return (
    <form onSubmit={handleSubmit} className="space-y-1" data-slot="create-user-form">
      <FormInput
        label="Name"
        name="add-user-name"
        value={formData.displayName}
        onChange={handleChange("displayName")}
        placeholder="Their name"
        error={errors.displayName}
        shake={errors.displayName}
        icon="username"
        disabled={busy}
        autoComplete="name"
        surface="secondary"
      />

      <FormInput
        label="Username"
        name="add-user-username"
        value={formData.username}
        onChange={handleChange("username")}
        placeholder="e.g. jamie"
        error={errors.username}
        shake={errors.username}
        icon="username"
        required
        disabled={busy}
        autoComplete="username"
        surface="secondary"
      />

      <div>
        <FormInput
          label="Password"
          name="add-user-password"
          type="password"
          value={formData.password}
          onChange={handleChange("password")}
          placeholder={PASSWORD_FIELD_PLACEHOLDER}
          error={passwordDisplayError}
          shake={passwordDisplayError || errors.form}
          icon="password"
          required
          disabled={busy}
          autoComplete="new-password"
          surface="secondary"
        />
        <PasswordStrengthChecklist password={formData.password} />
      </div>

      <div className="mb-4 flex items-center gap-3 px-5 py-2 bg-primary/10 rounded-pill">
        <span className="text-accent font-sans text-sm motion-safe:transition-all shrink-0 inline-flex items-center gap-1.5">
          Role
          <InfoHint
            label="What Admin means"
            content="An admin can add users, change settings, and manage this Luna."
          />
        </span>
        <Dropdown
          value={formData.role}
          onChange={(val) => {
            setFormData((prev) => ({ ...prev, role: val }));
            setErrors((prev) => ({ ...prev, role: "", form: "" }));
          }}
          disabled={busy}
          bg="primary"
          aria-label="Role"
          options={[
            { value: "user", label: "Member" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </div>

      <ModalErrorNotice error={errors.form || null} />

      <div className="flex gap-3 pt-1">
        <Button type="submit" variant="primary" loading={busy} className="flex-1 py-3">
          {busy ? (
            "Adding…"
          ) : (
            <>
              Add user
              <ArrowRight size={18} aria-hidden="true" />
            </>
          )}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

CreateUserForm.propTypes = {
  onSubmit: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  submitError: PropTypes.string,
  onCancel: PropTypes.func,
  resetKey: PropTypes.any,
};
