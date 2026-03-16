import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, AlertCircle, Loader2, Check, X } from "lucide-react";

export default function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("checking"); // checking, preflight, setup, creating, complete, error
  const [error, setError] = useState(null);
  const [preflightData, setPreflightData] = useState(null);
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
          setStep("preflight");
        }
      } catch {
        setError("Failed to check setup status");
        setStep("error");
      }
    };

    checkSetupStatus();
  }, [navigate]);

  // Run preflight checks
  useEffect(() => {
    const runPreflight = async () => {
      if (step !== "preflight") return;
      
      try {
        const response = await fetch("/api/v1/setup/preflight");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        setPreflightData(data);
        
        if (data.healthy) {
          setStep("setup");
        } else {
          setError("System checks failed. Please fix the issues below before continuing.");
        }
      } catch (err) {
        setError(`Failed to run system checks: ${err.message}`);
        setStep("error");
      }
    };

    runPreflight();
  }, [step]);

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

  if (step === "preflight") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-accent mx-auto mb-4" />
          <p className="text-secondary">Running system checks...</p>
          {preflightData && (
            <div className="mt-4">
              <p className="text-sm text-secondary/70">
                Checks complete: {preflightData.healthy ? "All passed" : "Some failed"}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-primary">
        <div className="max-w-md w-full mx-4">
           <div className="bg-secondary rounded-3xl p-8 ring-2 ring-accent">
            <AlertCircle className="w-16 h-16 text-accent mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-center text-primary mb-2">Setup Error</h1>
            <p className="text-center text-primary/80 mb-4">{error}</p>
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
           <div className="bg-secondary rounded-3xl p-8 ring-2 ring-accent text-center">
            <CheckCircle2 className="w-16 h-16 text-accent mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-primary mb-2">Setup Complete!</h1>
            <p className="text-primary/80 mb-4">Redirecting you to login...</p>
            <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary p-4">
      <div className="max-w-2xl w-full">
        <div className="bg-secondary rounded-3xl p-8 ring-2 ring-accent">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-primary mb-2">Welcome to LibreServ</h1>
            <p className="text-primary/80">
              Let's set up your admin account to get started
            </p>
          </div>

          {/* Preflight success summary */}
          {preflightData && preflightData.healthy && (
            <div className="mb-8 p-4 bg-accent/10 rounded-2xl border-2 border-accent/30">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
                  <Check className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <h3 className="font-bold text-primary">System Ready</h3>
                  <p className="text-sm text-primary/70">
                    All system checks passed successfully
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(preflightData.checks || {}).slice(0, 6).map(([name]) => (
                  <div key={name} className="flex items-center gap-2">
                    <Check className="w-3 h-3 text-accent" />
                    <span className="text-xs text-primary/80 capitalize">
                      {name.replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Preflight results */}
          {preflightData && !preflightData.healthy && (
            <div className="mb-8 p-6 bg-primary rounded-2xl border-2 border-accent">
              <h2 className="text-xl font-bold text-primary mb-4 flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-accent" />
                System Check Required
              </h2>
              <p className="text-primary/80 mb-4">
                The following system checks must pass before setup can continue:
              </p>
              
              <div className="space-y-3 mb-6">
                {Object.entries(preflightData.checks || {}).map(([name, check]) => (
                  <div key={name} className="flex items-center gap-3 p-3 bg-secondary/50 rounded-xl">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      check.status === "ok" ? "bg-accent/20 text-accent" : "bg-accent text-primary"
                    }`}>
                      {check.status === "ok" ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-center">
                        <span className="font-semibold text-primary capitalize">
                          {name.replace(/_/g, " ")}
                        </span>
                        <span className={`text-sm px-2 py-0.5 rounded-full ${
                          check.status === "ok" ? "bg-accent/20 text-accent" : "bg-accent text-primary"
                        }`}>
                          {check.status === "ok" ? "PASS" : "FAIL"}
                        </span>
                      </div>
                      {check.error && (
                        <p className="text-sm text-primary/70 mt-1">{check.error}</p>
                      )}
                      {name === "disk_space" && check.status === "ok" && check.disk_space_bytes_free && (
                        <p className="text-sm text-primary/70 mt-1">
                          {Math.round(check.disk_space_bytes_free / (1024 * 1024))} MB available
                        </p>
                      )}
                      {name === "smtp" && check.smtp_configured !== undefined && (
                        <p className="text-sm text-primary/70 mt-1">
                          SMTP {check.smtp_configured ? "configured" : "not configured"}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="flex-1 bg-accent text-primary py-3 rounded-pill font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Re-run Checks
                </button>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && !preflightData && (
            <div className="mb-6 p-4 bg-primary rounded-2xl border-2 border-accent">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-accent">Setup Failed</p>
                  <p className="text-sm text-secondary/80">{error}</p>
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
                 className="block text-sm font-semibold text-primary mb-2"
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
                  className="w-full px-4 py-3 bg-primary text-secondary rounded-2xl ring-2 ring-primary/50 focus-visible:ring-accent focus:ring-4 transition-all"
                  placeholder="admin"
                  disabled={step === "creating"}
                />
               <p className="text-xs text-primary/70 mt-1">
                 This will be your login username
               </p>
             </div>

             {/* Email */}
             <div>
               <label
                 htmlFor="admin_email"
                 className="block text-sm font-semibold text-primary mb-2"
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
                  className="w-full px-4 py-3 bg-primary text-secondary rounded-2xl ring-2 ring-primary/50 focus-visible:ring-accent focus:ring-4 transition-all"
                  placeholder="admin@example.com"
                  disabled={step === "creating"}
                />
               <p className="text-xs text-primary/70 mt-1">
                 Used for notifications and account recovery
               </p>
             </div>

             {/* Password */}
             <div>
               <label
                 htmlFor="admin_password"
                 className="block text-sm font-semibold text-primary mb-2"
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
                  className="w-full px-4 py-3 bg-primary text-secondary rounded-2xl ring-2 ring-primary/50 focus-visible:ring-accent focus:ring-4 transition-all"
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
                  <div className="text-xs space-y-1 text-primary/80">
                    <div
                      className={
                        passwordStrength.hasLength
                          ? "text-accent"
                          : "text-primary/70"
                      }
                    >
                      {passwordStrength.hasLength ? "✓" : "○"} At least 12
                      characters
                    </div>
                    <div
                      className={
                        passwordStrength.hasLetter
                          ? "text-accent"
                          : "text-primary/70"
                      }
                    >
                      {passwordStrength.hasLetter ? "✓" : "○"} Contains letters
                    </div>
                    <div
                      className={
                        passwordStrength.hasDigit
                          ? "text-accent"
                          : "text-primary/70"
                      }
                    >
                      {passwordStrength.hasDigit ? "✓" : "○"} Contains numbers
                    </div>
                    <div
                      className={
                        passwordStrength.hasSpecial
                          ? "text-accent"
                          : "text-primary/70"
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
          <div className="mt-8 pt-6 border-t border-primary/20 text-center text-xs text-primary/70">
            <p>LibreServ • Self-hosted cloud platform</p>
          </div>
        </div>
      </div>
    </div>
  );
}
