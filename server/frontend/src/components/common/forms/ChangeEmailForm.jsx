import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { Mail } from "lucide-react";

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

      <div>
        <label
          htmlFor="email"
          className="text-secondary/80 font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          New Email
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
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError("");
              }}
              placeholder="e.g. user@example.com"
className={`w-full pl-11 pr-4 py-2 border-2 rounded-pill focus:ring-2 focus:ring-accent focus:ring-offset-2 ${
                 error ? "border-accent" : "border-primary/30 focus:border-accent"
               }`}
              disabled={loading}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "email-error" : undefined}
            />
        </div>
        {error && (
        <p id="email-error" className="text-secondary/80 text-xs mt-1 px-5">
          {error}
        </p>
        )}
      </div>

      <div className="flex gap-3">
           <button
             type="button"
             onClick={onCancel}
             className="flex-1 px-4 py-2 bg-primary text-secondary rounded-pill motion-safe:transition-all hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary hover:ring-solid font-medium text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
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
          {loading ? "Saving..." : "Change Email"}
        </button>
      </div>
    </form>
  );
}
