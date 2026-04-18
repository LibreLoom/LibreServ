import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/ui/Button";
import Alert from "../components/common/Alert";
import { useToast } from "../context/ToastContext";

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

  useEffect(() => {
    const t = searchParams.get("token");
    if (!t) {
      setError("Missing reset token");
      setValidating(false);
      return;
    }
    setToken(t);

    // Validate token
    validateToken(t);
  }, [searchParams]);

  async function validateToken(t) {
    try {
      const res = await fetch(`/api/v1/auth/password-reset/validate?token=${encodeURIComponent(t)}`);
      const data = await res.json();
      
      if (data.valid) {
        setTokenValid(true);
      } else {
        setError("This reset link is invalid or has expired");
      }
    } catch (err) {
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
      const res = await fetch("/api/v1/auth/password-reset/confirm", {
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
      
      // Redirect to login after 3 seconds
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
        <div className="w-full max-w-lg bg-secondary rounded-large-element p-8 text-center">
          <h1 className="text-2xl font-mono text-center mb-6">Reset Password</h1>
          <div className="animate-spin inline-block w-8 h-8 border-4 border-primary border-t-primary rounded-full"></div>
          <p className="text-accent mt-4">Validating reset link...</p>
        </div>
      </main>
    );
  }

  if (!tokenValid && !success) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-primary px-4">
        <div className="w-full max-w-lg bg-secondary rounded-large-element p-8">
          <h1 className="text-2xl font-mono text-center mb-6">Reset Password</h1>
          <Alert variant="error" message={error || "Invalid or expired reset link"} />
          <Button onClick={() => navigate("/login")} fullWidth className="mt-6">
            Back to Login
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 grid place-items-center bg-primary px-4">
      <div className="w-full max-w-lg bg-secondary rounded-large-element p-8">
        <h1 className="text-2xl font-mono text-center mb-6">Reset Password</h1>
        
        {success ? (
          <>
            <Alert variant="success" message="Password reset successfully! Redirecting to login..." />
            <div className="mt-6 text-center">
              <a href="/login" className="text-accent underline">
                Go to login now
              </a>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p className="text-accent text-sm mb-4">
              Enter your new password below.
            </p>
            
            <label className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block">
              New Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent"
              required
              minLength={8}
            />
            
            <label className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="w-full border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent"
              required
            />
            
            {error && (
              <Alert variant="error" message={error} className="mb-4" />
            )}
            
            <Button type="submit" disabled={loading} fullWidth>
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
