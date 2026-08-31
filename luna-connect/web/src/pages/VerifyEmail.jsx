import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, MailCheck, X } from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const { markEmailVerified, refresh } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const fromOnboarding = searchParams.get("from") === "onboarding";
  const [status, setStatus] = useState("verifying");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No verification link found. Open the link from your email again.");
      return;
    }
    api("/api/v1/account/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async () => {
        markEmailVerified();
        try {
          await refresh?.();
        } catch {
          /* local mark is enough for onboarding to advance */
        }
        setStatus("success");
      })
      .catch((err) => {
        setStatus("error");
        setError(err.message || "This verification link is invalid or has expired.");
      });
  }, [token, markEmailVerified, refresh]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        {status === "verifying" && (
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 animate-spin text-muted-foreground" />
            <h1 className="font-mono text-2xl text-foreground">Verifying your email…</h1>
            <p className="text-muted-foreground text-sm">Just a moment while we confirm your email address.</p>
          </div>
        )}

        {status === "success" && (
          <div className="flex flex-col items-center gap-4 animate-fade-in-up">
            <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center">
              <MailCheck className="w-8 h-8 text-success" />
            </div>
            <h1 className="font-mono text-2xl text-foreground">Email verified!</h1>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
              {fromOnboarding
                ? "Your email address has been confirmed. Head back to finish setting up Luna."
                : "Your email address has been confirmed. You can use Luna Connect now."}
            </p>
            <Button
              size="lg"
              className="mt-2"
              onClick={() => navigate(fromOnboarding ? "/onboarding" : "/", { replace: true })}
            >
              {fromOnboarding ? "Back to Setup" : "Go to Luna Connect"}
            </Button>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-error/20 flex items-center justify-center">
              <X className="w-8 h-8 text-error" />
            </div>
            <h1 className="font-mono text-2xl text-foreground">Verification failed</h1>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">{error}</p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => navigate("/onboarding", { replace: true })}>
                Back to setup
              </Button>
              <Button onClick={() => navigate("/")}>Go to Luna Connect</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
