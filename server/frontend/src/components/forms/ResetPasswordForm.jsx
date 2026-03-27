import { useState, useCallback } from "react";
import { useAuth } from "../../hooks/useAuth";
import { Lock } from "lucide-react";
import FormInput from "./FormInput";
import FormButtonGroup from "./FormButtonGroup";

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

      <FormInput
        label="Current Password"
        name="oldPassword"
        type="password"
        value={formData.oldPassword}
        onChange={handleChange("oldPassword")}
        placeholder="Enter current password"
        error={errors.oldPassword}
        icon="password"
        required
      />

      <FormInput
        label="New Password"
        name="newPassword"
        type="password"
        value={formData.newPassword}
        onChange={handleChange("newPassword")}
        placeholder="Minimum 12 characters (letters and numbers)"
        error={errors.newPassword}
        icon="password"
        required
      />

      {errors.form && (
        <div className="bg-accent/10 border border-accent/50 rounded-pill px-4 py-2 text-accent text-sm text-center">
          {errors.form}
        </div>
      )}

      <FormButtonGroup
        submitLabel="Reset Password"
        cancelLabel="Cancel"
        onCancel={onCancel}
        loading={loading}
      />
    </form>
  );
}
