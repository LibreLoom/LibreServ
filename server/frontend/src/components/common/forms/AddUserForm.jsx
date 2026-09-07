import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import FormInput from "./FormInput";
import Dropdown from "../Dropdown";
import Button from "../../ui/Button";
import PasswordStrengthChecklist from "../PasswordStrengthChecklist";
import {
  passwordPolicyError,
  PASSWORD_FIELD_PLACEHOLDER,
} from "../../../lib/passwordPolicy";
import { ICON_SIZE } from "@/lib/ui-tokens";

/**
 * @param {{ onSuccess?: any }} _
 */
export default function AddUserForm({ onSuccess }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));

  const handleChange = useCallback(
    (field) => (e) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      // Clear submit-time field errors while typing — do not re-set live
      // password policy errors (checklist covers those without shaking).
      setErrors((prev) => ({ ...prev, [field]: "" }));
    },
    [],
  );

  const validateForm = useCallback(() => {
    const newErrors = {};
    if (!formData.username.trim()) {
      newErrors.username = "Username is required";
    }
    const passwordError = passwordPolicyError(formData.password);
    if (passwordError) {
      newErrors.password = passwordError;
    }
    return newErrors;
  }, [formData]);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      const validationErrors = validateForm();
      if (Object.keys(validationErrors).length > 0) {
        setErrors(/** @type {any} */ (validationErrors));
        return;
      }

      setLoading(true);
      setErrors({});

      try {
        const response = await request("/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });

        const result = await response.json();
        onSuccess?.(result);
      } catch (err) {
        const status = err.cause?.status;
        if (err.name === "AuthError") {
          // Session expired / refresh failed: tell the user to log in again
          // instead of blaming the form data.
          setErrors({ form: err.message });
        } else if (status === 409) {
          // The backend uses 409 for both username and email conflicts; point
          // the error at the field that actually clashed.
          const message = (err.message || "").toLowerCase();
          if (message.includes("email")) {
            setErrors({ email: "Email is already in use" });
          } else {
            setErrors({ username: "Username already exists" });
          }
        } else if (status === 400) {
          const message = err.message || "Invalid input";
          if (message.includes("password")) {
            setErrors({ password: message });
          } else {
            setErrors({ form: message });
          }
        } else {
          setErrors({ form: "Failed to create user. Please try again." });
        }
      } finally {
        setLoading(false);
      }
    },
    [formData, request, validateForm, onSuccess],
  );

  // Live unmet requirements are shown by the checklist. Hide the duplicate
  // policy string under the field so the form height stays stable while typing.
  const policyMessage = passwordPolicyError(formData.password);
  const hidePolicyErrorUnderField =
    formData.password.length > 0 &&
    Boolean(errors.password) &&
    (errors.password === policyMessage || errors.password === "Choose a stronger password.");
  const passwordDisplayError = hidePolicyErrorUnderField ? null : errors.password || null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-slot="add-user-form">
      <FormInput
        label="Username"
        name="username"
        value={formData.username}
        onChange={handleChange("username")}
        placeholder="e.g. johndoe"
        error={errors.username}
        shake={errors.username}
        icon="username"
        required
        disabled={loading}
      />

      <FormInput
        label="Email (optional)"
        name="email"
        type="email"
        value={formData.email}
        onChange={handleChange("email")}
        placeholder="e.g. john@example.com"
        error={errors.email}
        shake={errors.email}
        icon="email"
        disabled={loading}
      />

      <div>
        <FormInput
          label="Password"
          name="password"
          type="password"
          value={formData.password}
          onChange={handleChange("password")}
          placeholder={PASSWORD_FIELD_PLACEHOLDER}
          error={passwordDisplayError}
          shake={passwordDisplayError || errors.form}
          icon="password"
          required
          disabled={loading}
        />
        <PasswordStrengthChecklist password={formData.password} />
      </div>

      <div className="mb-4 flex items-center gap-3 px-5 py-2 bg-primary/10 rounded-pill">
        <label
          htmlFor="role"
          className="text-accent font-sans text-sm motion-safe:transition-all shrink-0"
        >
          Role:
        </label>
        <Dropdown
          value={formData.role}
          onChange={(val) => { setFormData((prev) => ({ ...prev, role: val })); setErrors((prev) => ({ ...prev, role: "" })); }}
          disabled={loading}
          bg="primary"
          options={[
            { value: "user", label: "User" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </div>

      {errors.form && (
        <div className="bg-error/10 border border-error/30 rounded-pill px-4 py-2 text-error text-sm text-center">
          {errors.form}
        </div>
      )}

      <Button type="submit" variant="primary" loading={loading} className="w-full py-3">
        {loading ? (
          "Creating..."
        ) : (
          <>
            Create User
            <ArrowRight size={ICON_SIZE.lg} aria-hidden="true" />
          </>
        )}
      </Button>
    </form>
  );
}

AddUserForm.propTypes = {
  onSuccess: PropTypes.func,
};
