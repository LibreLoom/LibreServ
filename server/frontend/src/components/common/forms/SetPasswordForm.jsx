import { cn } from "@/lib/utils";
import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { Lock, KeyRound } from "lucide-react";
import Button from "../../ui/Button";

/**
 * Admin "set password" form — sets a user's password directly (no current
 * password required), via PUT /api/v1/users/{id}/password. Distinct from the
 * self-service ResetPasswordForm, which verifies the old password.
 *
 * @param {{ user: any, onSuccess?: () => void, onCancel?: () => void }} props
 */
export default function SetPasswordForm({ user, onSuccess, onCancel }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({ newPassword: "", confirm: "" });
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
    const newErrors = /** @type {Record<string, string>} */ ({});
    const { newPassword, confirm } = formData;
    if (newPassword.length < 12) {
      newErrors.newPassword = "Password must be at least 12 characters";
    } else if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      newErrors.newPassword = "Password must include letters and numbers";
    }
    if (confirm !== newPassword) {
      newErrors.confirm = "Passwords don't match";
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
        await request(`/users/${user.id}/password`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_password: formData.newPassword }),
        });
        onSuccess?.();
      } catch (err) {
        const status = err?.cause?.status;
        if (status === 404) {
          setErrors({ form: "We couldn't find that user. They may have been deleted." });
        } else if (status === 400) {
          setErrors({ form: err?.message || "That password doesn't meet the requirements." });
        } else {
          setErrors({ form: "We couldn't set that password. Please try again." });
        }
      } finally {
        setLoading(false);
      }
    },
    [formData, request, user, validateForm, onSuccess],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-slot="set-password-form">
      <div className="text-center mb-4">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-secondary mb-3">
          <KeyRound size={24} aria-hidden="true" />
        </div>
        <p className="text-sm text-primary/80">
          Set a new password for <strong>{user.username}</strong>
        </p>
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="text-primary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
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
            className={cn(
              "w-full pl-11 pr-4 py-2 border-2 rounded-pill focus-visible:ring-2 focus:ring-accent focus:ring-offset-2",
              errors.newPassword && "border-error",
              !errors.newPassword && "border-primary/30 focus:border-accent",
            )}
            disabled={loading}
            aria-invalid={Boolean(errors.newPassword)}
            aria-describedby={errors.newPassword ? "new-password-error" : undefined}
          />
        </div>
        {errors.newPassword && (
          <p id="new-password-error" className="text-error text-xs mt-1 px-5 animate-fade-in-up">
            {errors.newPassword}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="text-primary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          Confirm Password
        </label>
        <div className="relative">
          <Lock
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/60"
            aria-hidden="true"
          />
          <input
            id="confirmPassword"
            type="password"
            value={formData.confirm}
            onChange={handleChange("confirm")}
            placeholder="Re-enter the new password"
            className={cn(
              "w-full pl-11 pr-4 py-2 border-2 rounded-pill focus-visible:ring-2 focus:ring-accent focus:ring-offset-2",
              errors.confirm && "border-error",
              !errors.confirm && "border-primary/30 focus:border-accent",
            )}
            disabled={loading}
            aria-invalid={Boolean(errors.confirm)}
            aria-describedby={errors.confirm ? "confirm-password-error" : undefined}
          />
        </div>
        {errors.confirm && (
          <p id="confirm-password-error" className="text-error text-xs mt-1 px-5 animate-fade-in-up">
            {errors.confirm}
          </p>
        )}
      </div>

      {errors.form && (
        <div className="bg-error/10 border border-error/30 rounded-pill px-4 py-2 text-error text-sm text-center">
          {errors.form}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" surface="secondary" onClick={onCancel} disabled={loading} className="flex-1">
          Cancel
        </Button>
        <Button type="submit" variant="accent" loading={loading} className="flex-1">
          {loading ? "Setting..." : "Set Password"}
        </Button>
      </div>
    </form>
  );
}