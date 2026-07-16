import { cn } from "@/lib/utils";
import { useState, useCallback, useMemo } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import FormInput from "./FormInput";
import Dropdown from "../Dropdown";
import Button from "../../ui/Button";

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
    <div className="mt-2 px-5">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i <= strength.score ? "bg-accent" : "bg-primary/20",
            )}
          />
        ))}
      </div>
      <p className="text-xs text-accent">{strength.label}</p>
    </div>
  );
}

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
      setErrors((prev) => ({ ...prev, [field]: "" }));
    },
    [],
  );

  const validateForm = useCallback(() => {
    const newErrors = {};
    if (!formData.username.trim()) {
      newErrors.username = "Username is required";
    }
    if (formData.password.length < 12) {
      newErrors.password = "Password must be at least 12 characters";
    } else {
      const hasLetter = /[a-zA-Z]/.test(formData.password);
      const hasDigit = /[0-9]/.test(formData.password);
      if (!hasLetter || !hasDigit) {
        newErrors.password = "Password must include letters and numbers";
      }
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-slot="add-user-form">
      <FormInput
        label="Username"
        name="username"
        value={formData.username}
        onChange={handleChange("username")}
        placeholder="e.g. johndoe"
        error={errors.username}
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
          placeholder="Minimum 12 characters (letters and numbers)"
          error={errors.password}
          icon="password"
          required
          disabled={loading}
        />
        <PasswordStrengthIndicator password={formData.password} />
      </div>

      <div className="mb-4 flex items-center gap-3 px-5 py-2 bg-primary/10 rounded-pill">
        <label
          htmlFor="role"
          className="text-primary/80 font-sans text-sm motion-safe:transition-all shrink-0"
        >
          Role:
        </label>
        <Dropdown
          value={formData.role}
          onChange={(val) => { setFormData((prev) => ({ ...prev, role: val })); setErrors((prev) => ({ ...prev, role: "" })); }}
          disabled={loading}
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

      <Button type="submit" variant="accent" loading={loading} className="w-full py-3">
        {loading ? (
          "Creating..."
        ) : (
          <>
            Create User
            <ArrowRight size={18} aria-hidden="true" />
          </>
        )}
      </Button>
    </form>
  );
}

AddUserForm.propTypes = {
  onSuccess: PropTypes.func,
};
