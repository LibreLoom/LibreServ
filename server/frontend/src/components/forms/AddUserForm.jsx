import { useState, useCallback, useMemo } from "react";
import { useAuth } from "../../hooks/useAuth";
import { Shield, ArrowRight } from "lucide-react";
import FormInput from "./FormInput";
import FormButtonGroup from "./FormButtonGroup";

function PasswordStrengthIndicator({ password }) {
  const strength = useMemo(() => {
    if (!password) return { score: 0, label: "", color: "" };

    let score = 0;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;

    if (score <= 2) return { score, label: "Weak", color: "bg-error" };
    if (score <= 3) return { score, label: "Fair", color: "bg-warning" };
    if (score <= 4) return { score, label: "Good", color: "bg-success" };
    return { score, label: "Strong", color: "bg-success" };
  }, [password]);

  if (!password) return null;

  return (
    <div className="mt-2 px-5">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= strength.score ? strength.color : "bg-primary/20"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-primary/60">{strength.label}</p>
    </div>
  );
}

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
      <FormInput
        label="Username"
        name="username"
        value={formData.username}
        onChange={handleChange("username")}
        placeholder="e.g. johndoe"
        error={errors.username}
        icon="username"
        required
      />

      <FormInput
        label="Email (optional)"
        name="email"
        type="email"
        value={formData.email}
        onChange={handleChange("email")}
        placeholder="e.g. john@example.com"
        icon="email"
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
        />
        <PasswordStrengthIndicator password={formData.password} />
      </div>

      <div className="mb-4">
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
            className="w-full pl-11 pr-10 py-2 border-2 rounded-pill focus-visible:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent bg-secondary cursor-pointer"
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
