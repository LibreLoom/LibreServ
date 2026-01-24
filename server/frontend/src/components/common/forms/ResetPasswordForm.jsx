import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { Lock } from "lucide-react";

export default function ResetPasswordForm({ user, onSuccess, onCancel }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    oldPassword: "",
    newPassword: "",
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
    if (!formData.oldPassword) {
      newErrors.oldPassword = "Current password is required";
    }
    if (formData.newPassword.length < 12) {
      newErrors.newPassword = "Password must be at least 12 characters";
    } else {
      const hasLetter = /[a-zA-Z]/.test(formData.newPassword);
      const hasDigit = /[0-9]/.test(formData.newPassword);
      if (!hasLetter || !hasDigit) {
        newErrors.newPassword = "Password must include letters and numbers";
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
        await request("/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            old_password: formData.oldPassword,
            new_password: formData.newPassword,
          }),
        });

        onSuccess?.();
      } catch (err) {
        const status = err.cause?.status;
        if (status === 400) {
          const message = err.message || "Invalid input";
          if (
            message.toLowerCase().includes("current") ||
            message.toLowerCase().includes("old")
          ) {
            setErrors({ oldPassword: message });
          } else if (message.toLowerCase().includes("password")) {
            setErrors({ newPassword: message });
          } else {
            setErrors({ form: message });
          }
        } else if (status === 401) {
          setErrors({ oldPassword: "Current password is incorrect" });
        } else {
          setErrors({ form: "Failed to reset password. Please try again." });
        }
      } finally {
        setLoading(false);
      }
    },
    [formData, request, validateForm, onSuccess],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-center mb-4">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-secondary mb-3">
          <Lock size={24} aria-hidden="true" />
        </div>
        <p className="text-sm text-primary/80">
          Reset password for <strong>{user.username}</strong>
        </p>
      </div>

      <div>
        <label
          htmlFor="oldPassword"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Current Password
        </label>
        <div className="relative">
          <Lock
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
          <input
            id="oldPassword"
            type="password"
            value={formData.oldPassword}
            onChange={handleChange("oldPassword")}
            placeholder="Enter current password"
            className={`w-full pl-11 pr-4 py-2 border-2 rounded-pill focus:outline-2 focus:outline-accent focus:outline-offset-2 ${
              errors.oldPassword
                ? "border-accent"
                : "border-primary/30 focus:border-accent"
            }`}
            disabled={loading}
            aria-invalid={Boolean(errors.oldPassword)}
            aria-describedby={
              errors.oldPassword ? "old-password-error" : undefined
            }
          />
        </div>
        {errors.oldPassword && (
          <p id="old-password-error" className="text-accent text-xs mt-1 px-5">
            {errors.oldPassword}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          New Password
        </label>
        <div className="relative">
          <Lock
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
          <input
            id="newPassword"
            type="password"
            value={formData.newPassword}
            onChange={handleChange("newPassword")}
            placeholder="Minimum 12 characters (letters and numbers)"
            className={`w-full pl-11 pr-4 py-2 border-2 rounded-pill focus:outline-2 focus:outline-accent focus:outline-offset-2 ${
              errors.newPassword
                ? "border-accent"
                : "border-primary/30 focus:border-accent"
            }`}
            disabled={loading}
            aria-invalid={Boolean(errors.newPassword)}
            aria-describedby={
              errors.newPassword ? "new-password-error" : undefined
            }
          />
        </div>
        {errors.newPassword && (
          <p id="new-password-error" className="text-accent text-xs mt-1 px-5">
            {errors.newPassword}
          </p>
        )}
      </div>

      {errors.form && (
        <div className="bg-accent/10 border border-accent/50 rounded-pill px-4 py-2 text-accent text-sm text-center">
          {errors.form}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2 bg-primary text-secondary rounded-pill motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid font-medium text-sm focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          disabled={loading}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className={`flex-1 px-4 py-2 bg-accent text-primary rounded-pill font-medium motion-safe:transition-all hover:ring-2 hover:ring-primary flex items-center justify-center gap-2 ${
            loading ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          {loading ? "Resetting..." : "Reset Password"}
        </button>
      </div>
    </form>
  );
}
