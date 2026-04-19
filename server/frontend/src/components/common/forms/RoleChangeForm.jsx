import { useState, useCallback } from "react";
import { useAuth } from "../../../hooks/useAuth";
import { Shield } from "lucide-react";
import Dropdown from "../Dropdown";

export default function RoleChangeForm({ user, onSuccess, onCancel }) {
  const { request } = useAuth();
  const [role, setRole] = useState(user?.role || "user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (role === user.role) {
        onCancel();
        return;
      }

      setLoading(true);
      setError("");

      try {
        await request(`/users/${user.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });

        onSuccess?.(role);
      } catch (err) {
        const status = err.cause?.status;
        if (status === 404) {
          setError("User not found");
        } else {
          setError("Failed to change role. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    },
    [user, role, request, onSuccess, onCancel],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-center mb-4">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-secondary mb-3">
          <Shield size={24} aria-hidden="true" />
        </div>
        <p className="text-sm text-primary/80">
          Change role for user <strong>{user.username}</strong>
        </p>
      </div>

      <div>
        <label
          htmlFor="role"
          className="text-secondary/80 font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          New Role
        </label>
        <Dropdown
          value={role}
          onChange={setRole}
          fullWidth
          disabled={loading}
          options={[
            { value: "user", label: "User" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </div>

      {error && (
        <div className="bg-accent/10 border border-accent/50 rounded-pill px-4 py-2 text-accent text-sm text-center">
          {error}
        </div>
      )}

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
          {loading ? "Changing..." : "Change Role"}
        </button>
      </div>
    </form>
  );
}
