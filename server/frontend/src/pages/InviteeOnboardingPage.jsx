import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Loader2, AlertCircle, ShieldCheck } from "lucide-react";
import api from "../lib/api";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import Alert from "../components/common/Alert";

// Password rules mirror the backend + the rest of the app.
function usePasswordStrength(password) {
  return useMemo(() => {
    if (!password) return { score: 0, label: "", ok: false };
    let score = 0;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^a-zA-Z0-9]/.test(password)) score += 1;
    const label = score <= 2 ? "Weak" : score <= 3 ? "Fair" : score <= 4 ? "Good" : "Strong";
    const ok = password.length >= 12 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
    return { score, label, ok };
  }, [password]);
}

/**
 * Public onboarding page reached via an invitation link (/invite/:token).
 * Validates the invite, then lets the invitee set a username + password. On
 * redeem the session is established — for an admin role, the MfaBlocker then
 * forces MFA enrollment on first UI use.
 */
export default function InviteeOnboardingPage() {
  const { token } = useParams();
  const [invite, setInvite] = useState(/** @type {{email?:string, role?:string, valid?:boolean}|null} */ (null));
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const strength = usePasswordStrength(password);

  useEffect(() => {
    let cancelled = false;
    api(`/auth/invite/${token}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setInvite(d); })
      .catch(() => { if (!cancelled) setError("We couldn't verify this invitation."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !strength.ok || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api(`/auth/invite/${token}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "We couldn't finish setting up your account.");
      }
      // Session is set — reload so AuthProvider picks up the new session (and the
      // MfaBlocker enforces MFA for admins).
      window.location.href = "/";
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-primary px-4" data-slot="invitee-onboarding">
        <Loader2 className="animate-spin text-accent" size={28} />
      </main>
    );
  }

  // Invalid / expired / already-redeemed invite. The backend returns the same
  // shape with valid=false — no leak of which.
  if (!invite || invite.valid === false) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-primary px-4" id="main-content" tabIndex={-1} data-slot="invitee-onboarding">
        <div className="w-full max-w-lg bg-secondary text-primary rounded-large-element p-8 text-center">
          <AlertCircle size={32} className="text-accent mx-auto mb-3" />
          <h1 className="font-mono text-xl mb-2">This invitation isn't valid</h1>
          <p className="text-primary/70 text-sm">
            The link may have expired or already been used. Ask the person who
            invited you to send a new one.
          </p>
        </div>
      </main>
    );
  }

  const isAdmin = invite.role === "admin";

  return (
    <main className="fixed inset-0 grid place-items-center bg-primary px-4 overflow-auto" id="main-content" tabIndex={-1} data-slot="invitee-onboarding">
      <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element pop-in p-8 my-8">
        <span className="text-primary font-mono text-2xl block text-center">LibreServ</span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <h1 className="text-primary font-mono text-xl font-normal block text-center">
          You're invited to join
        </h1>
        <p className="text-primary/80 text-sm text-center mt-2">
          Invited as <span className="font-medium">{invite.email}</span> ({invite.role}).
          Set your username and password to finish.
        </p>

        {isAdmin && (
          <p className="text-accent text-xs flex items-center justify-center gap-2 mt-3">
            <ShieldCheck size={14} /> Admin accounts need two-factor authentication —
            you'll set it up after this step.
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col mt-6 rounded-large-element p-4 bg-primary text-secondary">
          <label htmlFor="username" className="text-secondary/80 font-sans text-sm text-left translate-x-5 mb-1 block">
            Username
          </label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Choose a username"
            className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent focus:ring-offset-2"
            autoComplete="username"
            required
          />
          <ShakeTarget shake={error}>
            <div>
              <label htmlFor="password" className="text-secondary/80 font-sans text-sm text-left translate-x-5 mb-1 block">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 12 characters (letters and numbers)"
                className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 focus:ring-2 focus:ring-accent focus:ring-offset-2 w-full"
                autoComplete="new-password"
                required
              />
            </div>
          </ShakeTarget>
          {password && (
            <div className="mt-2 px-5">
              <div className="flex gap-1 mb-1">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className={cn("h-1 flex-1 rounded-full", i <= strength.score ? "bg-accent" : "bg-secondary/20")}
                  />
                ))}
              </div>
              <p className="text-xs text-accent">{strength.label}</p>
            </div>
          )}

          <Button
            type="submit"
            variant="secondary"
            surface="primary"
            loading={submitting}
            disabled={submitting || !username.trim() || !strength.ok}
            className="mt-6 p-2"
          >
            {submitting ? "Setting up…" : "Finish setup"}
          </Button>
          {error && <Alert variant="error" message={error} className="mt-4" />}
        </form>
      </div>
    </main>
  );
}