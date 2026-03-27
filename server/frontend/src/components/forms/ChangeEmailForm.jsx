import { useState, useCallback } from "react";
import { useAuth } from "../../hooks/useAuth";
import { Mail } from "lucide-react";
import FormInput from "./FormInput";
import FormButtonGroup from "./FormButtonGroup";

export default function ChangeEmailForm({ user, onSuccess, onCancel }) {
  const { request } = useAuth();
  const [email, setEmail] = useState(user?.email || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (email === user.email) {
        onCancel();
        return;
      }

      setLoading(true);
      setError("");

      try {
        await request(`/users/${user.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        onSuccess?.(email);
      } catch (err) {
        const status = err.cause?.status;
        if (status === 404) {
          setError("User not found");
        } else if (status === 400) {
          setError("Invalid email address");
        } else {
          setError("Failed to change email. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    },
    [user, email, request, onSuccess, onCancel],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-center mb-4">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-secondary mb-3">
          <Mail size={24} aria-hidden="true" />
        </div>
        <p className="text-sm text-primary/80">
          Change email for <strong>{user.username}</strong>
        </p>
      </div>

      <FormInput
        label="New Email"
        name="email"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError("");
        }}
        placeholder="e.g. user@example.com"
        error={error}
        icon="email"
      />

      <FormButtonGroup
        submitLabel="Change Email"
        cancelLabel="Cancel"
        onCancel={onCancel}
        loading={loading}
      />
    </form>
  );
}
