import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import FormInput from "./FormInput";
import Dropdown from "../Dropdown";
import Button from "../../ui/Button";
import ModalErrorNotice from "../ModalErrorNotice";
import { InfoHint } from "../../ui/Tooltip";
import {
  PASSWORD_POLICY_HINT,
  meetsPasswordPolicy,
  passwordPolicyError,
} from "../../../lib/passwordPolicy";

/**
 * Password strength meter — ported from LibreServ AddUserForm.
 * Bars fill as length, mixed case, digits, and symbols accumulate.
 * Policy gate (12+ / letter / number) stays in passwordPolicy.js.
 */
function PasswordStrengthIndicator({ password }) {
  const strength = useMemo(() => {
    if (!password) return { score: 0, label: "" };

    let score = 0;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;

    if (score <= 2) return { score, label: "Weak" };
    if (score <= 3) return { score, label: "Fair" };
    if (score <= 4) return { score, label: "Good" };
    return { score, label: "Strong" };
  }, [password]);

  if (!password) return null;

  return (
    <div className="mt-2 px-5" data-slot="password-strength">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full motion-safe:transition-colors",
              i <= strength.score ? "bg-accent" : "bg-primary/20",
            )}
          />
        ))}
      </div>
      <p className="text-xs text-accent font-mono">{strength.label}</p>
    </div>
  );
}

PasswordStrengthIndicator.propTypes = {
  password: PropTypes.string.isRequired,
};

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
    setFormData({ displayName: "", username: "", password: "", role: "user" });
    setErrors({});
  }, [resetKey]);

  useEffect(() => {
    if (!submitError) return;
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
    } else if (username.length < 3 || username.length > 32) {
      next.username = "Usernames are 3–32 letters, numbers, dots, dashes, or underscores.";
    } else if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      next.username = "Usernames are 3–32 letters, numbers, dots, dashes, or underscores.";
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
        setErrors(validationErrors);
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
          placeholder={PASSWORD_POLICY_HINT}
          error={errors.password}
          shake={errors.password || errors.form}
          icon="password"
          required
          disabled={busy}
          autoComplete="new-password"
          surface="secondary"
        />
        <PasswordStrengthIndicator password={formData.password} />
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
