import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { User, Mail, Shield, Lock, ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import PasswordStrengthIndicator from "../../forms/PasswordStrengthIndicator";

export default function AddUserForm({ onSuccess }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

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
        setErrors(validationErrors);
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
        if (status === 409) {
          setErrors({ username: "Username already exists" });
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="username"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Username
        </label>
        <div className="relative">
          <User
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
            <input
              id="username"
              type="text"
              value={formData.username}
              onChange={handleChange("username")}
              placeholder="e.g. johndoe"
              className={`w-full pl-11 pr-4 py-2 border-2 rounded-pill focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                errors.username
                  ? "border-error"
                  : "border-primary/30 focus-visible:border-accent"
              }`}
              disabled={loading}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? "username-error" : undefined}
            />
        </div>
        {errors.username && (
          <p id="username-error" className="text-accent text-xs mt-1 px-5">
            {errors.username}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="email"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Email (optional)
        </label>
        <div className="relative">
          <Mail
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
            <input
              id="email"
              type="email"
              value={formData.email}
              onChange={handleChange("email")}
              placeholder="e.g. john@example.com"
              className="w-full pl-11 pr-4 py-2 border-2 rounded-pill focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 border-primary/30 focus-visible:border-accent"
              disabled={loading}
            />
        </div>
      </div>

      <div>
        <label
          htmlFor="password"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Password
        </label>
        <div className="relative">
          <Lock
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
            <input
              id="password"
              type="password"
              value={formData.password}
              onChange={handleChange("password")}
              placeholder="Minimum 12 characters (letters and numbers)"
              className={`w-full pl-11 pr-4 py-2 border-2 rounded-pill focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                errors.password
                  ? "border-error"
                  : "border-primary/30 focus-visible:border-accent"
              }`}
              disabled={loading}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
        </div>
        {errors.password && (
          <p id="password-error" className="text-accent text-xs mt-1 px-5">
            {errors.password}
          </p>
        )}
        <PasswordStrengthIndicator password={formData.password} />
      </div>

      <div>
        <label
          htmlFor="role"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Role
        </label>
        <div className="relative">
          <Shield
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
          <select
            id="role"
            value={formData.role}
            onChange={handleChange("role")}
            className="w-full pl-11 pr-10 py-2 border-2 rounded-pill focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 border-primary/30 focus-visible:border-accent bg-secondary cursor-pointer"
            disabled={loading}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>

      {errors.form && (
        <div className="bg-accent/10 border border-accent/50 rounded-pill px-4 py-2 text-accent text-sm text-center">
          {errors.form}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className={`w-full bg-accent hover:bg-primary text-primary hover:text-accent rounded-pill py-3 font-medium motion-safe:transition-all hover:ring-2 hover:ring-accent flex items-center justify-center gap-2 ${
          loading ? "opacity-50 cursor-not-allowed" : ""
        }`}
      >
        {loading ? (
          "Creating..."
        ) : (
          <>
            Create User
            <ArrowRight size={18} aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}

AddUserForm.propTypes = {
  onSuccess: PropTypes.func,
};
