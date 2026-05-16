import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/ui/Button";
import Alert from "../components/common/Alert";
import { useToast } from "../context/ToastContext";
import { passwordreset as resetQuips } from "../assets/greetings";
import api from "../lib/api";

function getResetQuip() {
  const hoursSinceEpoch = Math.floor(Date.now() / 43200000);
  return resetQuips[hoursSinceEpoch % resetQuips.length];
}

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [validating, setValidating] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const resetQuip = useMemo(() => getResetQuip(), []);

  useEffect(() => {
    const t = searchParams.get("token");
    if (!t) {
      setError("Missing reset token");
      setValidating(false);
      return;
    }
    setToken(t);
    validateToken(t);
  }, [searchParams]);

  async function validateToken(t) {
    try {
      const res = await api("/auth/password-reset/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const data = await res.json();

      if (data.valid) {
        setTokenValid(true);
      } else {
        setError("This reset link is invalid or has expired");
      }
    } catch {
      setError("Failed to validate reset link");
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await api("/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to reset password");
      }

      setSuccess(true);
      addToast({ type: "success", message: "Password reset successfully!" });

      setTimeout(() => {
        navigate("/login");
      }, 3000);
    } catch (err) {
      setError(err.message);
      addToast({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }

  if (validating) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-primary px-4">
        <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in p-8">
          <span className="text-primary font-mono text-2xl block text-center">
            LibreServ
          </span>
          <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
          <span className="text-primary font-mono text-xl font-normal block text-center">
            Validating reset link...
          </span>
          <p className="text-primary/80 text-sm text-center mt-2">{resetQuip}</p>
          <div className="flex justify-center mt-6">
            <div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
        </div>
      </main>
    );
  }

  if (!tokenValid && !success) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-primary px-4">
        <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in p-8">
          <span className="text-primary font-mono text-2xl block text-center">
            LibreServ
          </span>
          <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
          <span className="text-primary font-mono text-xl font-normal block text-center">
            Reset Password
          </span>
          <p className="text-primary/80 text-sm text-center mt-2">{resetQuip}</p>
          <div className="mt-6">
            <Alert variant="error" message={error || "Invalid or expired reset link"} />
          </div>
          <Button
            variant="secondary"
            onClick={() => navigate("/login")}
            fullWidth
            className="mt-6"
          >
            Back to Login
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 grid place-items-center bg-primary px-4">
      <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in p-8">
        <span className="text-primary font-mono text-2xl block text-center">
          LibreServ
        </span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <span className="text-primary font-mono text-xl font-normal block text-center">
          Reset Password
        </span>
        <p className="text-primary/80 text-sm text-center mt-2">{resetQuip}</p>

        {success ? (
          <div className="mt-6">
            <Alert variant="success" message="Password reset successfully! Redirecting to login..." />
            <div className="mt-4 text-center">
              <a href="/login" className="text-primary/80 underline text-sm">
                Go to login now
              </a>
            </div>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            aria-busy={loading}
            className="flex flex-col mt-6 rounded-large-element p-4 bg-primary text-secondary"
          >
            <label htmlFor="new-password" className="text-secondary/80 font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1">
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent focus:ring-offset-2"
              required
              minLength={8}
              autoComplete="new-password"
            />

            <label htmlFor="confirm-password" className="text-secondary/80 font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1">
              Confirm Password
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent focus:ring-offset-2"
              required
              autoComplete="new-password"
            />

            {error && (
              <Alert variant="error" message={error} className="mb-4" />
            )}

            <Button
              type="submit"
              variant="secondary"
              disabled={loading}
              fullWidth
              className="mt-2"
            >
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
