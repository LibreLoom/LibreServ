import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

export default function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("checking"); // checking, setup, creating, complete, error
  const [error, setError] = useState(null);
  const [formData, setFormData] = useState({
    admin_username: "",
    admin_password: "",
    admin_email: "",
  });
  const [passwordStrength, setPasswordStrength] = useState(null);

  // Check if setup is needed
  useEffect(() => {
    const checkSetupStatus = async () => {
      try {
        const response = await fetch("/api/v1/setup/status");
        const data = await response.json();

        if (data.setup_state?.status === "complete") {
          navigate("/");
        } else {
          setStep("setup");
        }
      } catch {
        setError("Failed to check setup status");
        setStep("error");
      }
    };

    checkSetupStatus();
  }, [navigate]);

  // Validate password strength
  useEffect(() => {
    const password = formData.admin_password;
    if (!password) {
      setPasswordStrength(null);
      return;
    }

    const hasLength = password.length >= 12;
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    const strength = {
      score: [hasLength, hasLetter, hasDigit, hasSpecial].filter(Boolean)
        .length,
      hasLength,
      hasLetter,
      hasDigit,
      hasSpecial,
    };

    setPasswordStrength(strength);
  }, [formData.admin_password]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStep("creating");
    setError(null);

    try {
      const response = await fetch("/api/v1/setup/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Setup failed");
      }

      setStep("complete");

      // Reload the page to trigger auth context refresh (user is now logged in via cookies)
      setTimeout(() => {
        window.location.href = "/";
      }, 1500);
    } catch (err) {
      setError(err.message);
      setStep("setup");
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const isFormValid = () => {
    return (
      formData.admin_username &&
      formData.admin_password &&
      formData.admin_email &&
      passwordStrength?.score >= 3
    );
  };

  if (step === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-accent mx-auto mb-4" />
          <p className="text-secondary">Checking setup status...</p>
        </div>
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary">
        <div className="max-w-md w-full mx-4">
          <div className="bg-secondary rounded-3xl p-8 outline outline-2 outline-accent">
            <AlertCircle className="w-16 h-16 text-accent mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-center mb-2">Setup Error</h1>
            <p className="text-center text-primary/70 mb-4">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-accent text-primary py-3 rounded-pill font-semibold hover:opacity-90 transition-opacity"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "complete") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary">
        <div className="max-w-md w-full mx-4">
          <div className="bg-secondary rounded-3xl p-8 outline outline-2 outline-accent text-center">
            <CheckCircle2 className="w-16 h-16 text-accent mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Setup Complete!</h1>
            <p className="text-primary/70 mb-4">Redirecting you to login...</p>
            <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary p-4">
      <div className="max-w-2xl w-full">
        <div className="bg-secondary rounded-3xl p-8 outline outline-2 outline-accent">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">Welcome to LibreServ</h1>
            <p className="text-primary/70">
              Let's set up your admin account to get started
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-6 p-4 bg-accent/20 border-2 border-accent rounded-2xl">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-accent">Setup Failed</p>
                  <p className="text-sm text-secondary/70">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Setup form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Username */}
            <div>
              <label
                htmlFor="admin_username"
                className="block text-sm font-semibold mb-2"
              >
                Admin Username
              </label>
              <input
                type="text"
                id="admin_username"
                name="admin_username"
                value={formData.admin_username}
                onChange={handleChange}
                required
                autoComplete="username"
                className="w-full px-4 py-3 bg-primary rounded-2xl outline outline-2 outline-accent focus:outline-4 transition-all"
                placeholder="admin"
                disabled={step === "creating"}
              />
              <p className="text-xs text-primary/60 mt-1">
                This will be your login username
              </p>
            </div>

            {/* Email */}
            <div>
              <label
                htmlFor="admin_email"
                className="block text-sm font-semibold mb-2"
              >
                Admin Email
              </label>
              <input
                type="email"
                id="admin_email"
                name="admin_email"
                value={formData.admin_email}
                onChange={handleChange}
                required
                autoComplete="email"
                className="w-full px-4 py-3 bg-primary rounded-2xl outline outline-2 outline-accent focus:outline-4 transition-all"
                placeholder="admin@example.com"
                disabled={step === "creating"}
              />
              <p className="text-xs text-primary/60 mt-1">
                Used for notifications and account recovery
              </p>
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="admin_password"
                className="block text-sm font-semibold mb-2"
              >
                Admin Password
              </label>
              <input
                type="password"
                id="admin_password"
                name="admin_password"
                value={formData.admin_password}
                onChange={handleChange}
                required
                autoComplete="new-password"
                className="w-full px-4 py-3 bg-primary rounded-2xl outline outline-2 outline-accent focus:outline-4 transition-all"
                placeholder="Enter a strong password"
                disabled={step === "creating"}
              />

              {/* Password strength indicator */}
              {passwordStrength && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((level) => (
                      <div
                        key={level}
                        className={`h-2 flex-1 rounded-full transition-colors ${
                          level <= passwordStrength.score
                            ? passwordStrength.score <= 2
                              ? "bg-accent"
                              : passwordStrength.score === 3
                                ? "bg-accent/70"
                                : "bg-accent"
                            : "bg-primary/20"
                        }`}
                      />
                    ))}
                  </div>
                  <div className="text-xs space-y-1">
                    <div
                      className={
                        passwordStrength.hasLength
                          ? "text-accent"
                          : "text-primary/60"
                      }
                    >
                      {passwordStrength.hasLength ? "✓" : "○"} At least 12
                      characters
                    </div>
                    <div
                      className={
                        passwordStrength.hasLetter
                          ? "text-accent"
                          : "text-primary/60"
                      }
                    >
                      {passwordStrength.hasLetter ? "✓" : "○"} Contains letters
                    </div>
                    <div
                      className={
                        passwordStrength.hasDigit
                          ? "text-accent"
                          : "text-primary/60"
                      }
                    >
                      {passwordStrength.hasDigit ? "✓" : "○"} Contains numbers
                    </div>
                    <div
                      className={
                        passwordStrength.hasSpecial
                          ? "text-accent"
                          : "text-primary/60"
                      }
                    >
                      {passwordStrength.hasSpecial ? "✓" : "○"} Contains special
                      characters (recommended)
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={!isFormValid() || step === "creating"}
              className="w-full bg-accent text-primary py-4 rounded-pill font-bold text-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {step === "creating" ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Creating Admin Account...
                </>
              ) : (
                "Complete Setup"
              )}
            </button>
          </form>

          {/* Footer */}
          <div className="mt-8 pt-6 border-t border-primary/20 text-center text-xs text-primary/60">
            <p>LibreServ • Self-hosted cloud platform</p>
          </div>
        </div>
      </div>
    </div>
  );
}
