import { useState, useCallback } from "react";
import { Mail } from "lucide-react";
import PropTypes from "prop-types";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import FormInput from "./FormInput";
import Dropdown from "../Dropdown";
import Button from "../../ui/Button";

/**
 * Send an invitation email so someone can create their own account. The
 * inviter picks the role; if admin, the invitee is forced through MFA enrollment
 * on first sign-in (via the fullscreen MfaBlocker). Requires SMTP to be set up.
 *
 * @param {{ onSuccess?: () => void } | undefined} [props]
 */
export default function InviteUserForm({ onSuccess } = {}) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (!email.trim() || loading) return;
      setLoading(true);
      setError(null);
      try {
        await request("/users/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), role }),
        });
        addToast({ type: "success", message: `Invitation sent to ${email.trim()}.` });
        setEmail("");
        setRole("user");
        onSuccess?.();
      } catch (err) {
        const status = err.cause?.status;
        if (err.name === "AuthError") {
          setError(err.message);
        } else if (status === 400) {
          setError(
            err.message ||
              "Email isn't set up on this server yet. Configure it in Settings → Email first.",
          );
        } else if (status === 409) {
          setError(err.message || "That email already has a pending invitation.");
        } else {
          setError(err.message || "Couldn't send the invitation. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    },
    [email, role, loading, request, addToast, onSuccess],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-primary/70 px-5">
        We'll email them a link to set their own username and password. If you make
        them an admin, they'll be asked to set up two-factor authentication before
        they can use LibreServ.
      </p>

      <FormInput
        label="Email"
        name="email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="e.g. john@example.com"
        icon="email"
        required
        disabled={loading}
      />

      <div className="mb-4 flex items-center gap-3 px-5 py-2 bg-primary/10 rounded-pill">
        <label
          htmlFor="invite-role"
          className="text-primary/80 font-sans text-sm shrink-0"
        >
          Role:
        </label>
        <Dropdown
          value={role}
          onChange={setRole}
          disabled={loading}
          options={[
            { value: "user", label: "User" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-pill px-4 py-2 text-error text-sm text-center">
          {error}
        </div>
      )}

      <Button
        type="submit"
        variant="accent"
        loading={loading}
        disabled={!email.trim()}
        className="w-full py-3"
      >
        {loading ? (
          "Sending..."
        ) : (
          <>
            Send Invitation
            <Mail size={16} aria-hidden="true" />
          </>
        )}
      </Button>
    </form>
  );
}

InviteUserForm.propTypes = { onSuccess: PropTypes.func };