import { cn } from "@/lib/utils";
import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { Mail } from "lucide-react";
import Button from "../../ui/Button";
import ShakeTarget from "../../ui/ShakeTarget";
import { ICON_SIZE } from "@/lib/ui-tokens";

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
    <form onSubmit={handleSubmit} className="space-y-4" data-slot="change-email-form">
      <div className="text-center mb-4">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-secondary mb-3">
          <Mail size={ICON_SIZE.xxl} aria-hidden="true" />
        </div>
        <p className="text-sm text-accent">
          Change email for <strong>{user.username}</strong>
        </p>
      </div>

      <ShakeTarget shake={error}>
        <div>
          <label
            htmlFor="email"
            className="text-secondary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
          >
            New Email
          </label>
          <div className="relative">
            <Mail
              size={ICON_SIZE.md}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-accent"
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
              className={cn(
                "w-full pl-11 pr-4 py-2 border-2 rounded-pill outline-none",
                error && "border-accent focus:border-accent",
                !error && "border-primary/30 focus:border-accent",
              )}
              disabled={loading}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "email-error" : undefined}
            />
          </div>
          {error && (
            <p id="email-error" className="text-secondary text-xs mt-1 px-5">
              {error}
            </p>
          )}
        </div>
      </ShakeTarget>

      <div className="flex gap-3">
        <Button
          variant="outline"
          surface="secondary"
          onClick={onCancel}
          disabled={loading}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={loading}
          className="flex-1"
        >
          {loading ? "Saving..." : "Change Email"}
        </Button>
      </div>
    </form>
  );
}
