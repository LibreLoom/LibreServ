import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client.js";
import { Button } from "../components/ui/button.jsx";
import { Check, X, Loader2, MailCheck } from "lucide-react";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState("verifying"); // verifying | success | error
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No verification token found. Check that you clicked the correct link in your email.");
      return;
    }

    api.verifyEmail(token)
      .then(() => setStatus("success"))
      .catch((err) => {
        setStatus("error");
        setError(err.message || "This verification link is invalid or has expired.");
      });
  }, [token]);

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
          <div className="flex flex-col items-center gap-4 animate-in fade-in-up duration-500">
            <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center">
              <MailCheck className="w-8 h-8 text-success" />
            </div>
            <h1 className="font-mono text-2xl text-foreground">Email verified!</h1>
            <p className="text-muted-foreground text-sm leading-relaxed max-w-sm">
              Your email address has been confirmed. You can now generate a license key
              and connect your LibreServ device.
            </p>
            <Button size="lg" className="mt-2" onClick={() => navigate("/")}>
              Go to Dashboard
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
              <Button variant="outline" onClick={() => navigate("/security")}>
                Resend verification email
              </Button>
              <Button onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
