import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, MailOpen } from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon } from "lucide-react";

export default function Register() {
  const { register, markEmailVerified } = useAuth();
  const { toggle } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [awaitingVerify, setAwaitingVerify] = useState(false);
  const [resendState, setResendState] = useState("idle");
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(email, password);
      setAwaitingVerify(true);
    } catch (err) {
      setError(err.message || "Could not create the account. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setResendState("sending");
    setError("");
    try {
      await api("/api/v1/account/resend-verification", {
        method: "POST",
        body: JSON.stringify({ source: "" }),
      });
      setResendState("sent");
    } catch (err) {
      setError(err.message || "Could not resend the email. Try again.");
      setResendState("idle");
    }
  }

  async function handleCheck() {
    setChecking(true);
    setError("");
    try {
      const res = await api("/api/v1/account/verification-status");
      if (res.email_verified) {
        markEmailVerified();
        window.location.href = "/";
      } else {
        setError("We don't see the verification yet. Click the link in the email first, then try again.");
      }
    } catch (err) {
      setError(err.message || "Couldn't check verification. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <button
        type="button"
        onClick={toggle}
        className="absolute top-4 right-4 rounded-pill p-2 text-muted-foreground hover:bg-accent transition-colors"
        aria-label="Toggle dark mode"
      >
        <Sun className="h-5 w-5 dark:hidden" />
        <Moon className="h-5 w-5 hidden dark:block" />
      </button>
      <Card className="w-full max-w-md animate-pop-in">
        {awaitingVerify ? (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                <MailOpen className="w-6 h-6 text-foreground" strokeWidth={1.75} />
              </div>
              <CardTitle className="text-3xl">Check your inbox</CardTitle>
              <CardDescription>
                We sent a verification link to{" "}
                <span className="font-mono text-card-foreground">{email}</span>. Open it to unlock Luna Connect.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Waiting for verification…
              </div>
              {error && <p className="text-sm text-error text-center">{error}</p>}
              <Button className="w-full" loading={checking} onClick={handleCheck}>
                Check Again
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                {resendState === "sent" ? (
                  "Verification email sent — check your inbox (and spam folder)."
                ) : (
                  <>
                    Didn't get it?{" "}
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resendState === "sending"}
                      className="underline underline-offset-2 hover:text-card-foreground disabled:opacity-60"
                    >
                      {resendState === "sending" ? "Sending…" : "Resend verification email"}
                    </button>
                  </>
                )}
              </p>
              <p className="text-center text-sm text-muted-foreground">
                Or continue in{" "}
                <Link to="/onboarding" className="font-mono text-foreground underline-offset-4 hover:underline">
                  setup
                </Link>
                .
              </p>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl">Create your account</CardTitle>
              <CardDescription>
                Open your Luna from your phone or computer when you are not at home. You can also keep a cloud backup of
                your files here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoFocus
                  />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters, letters and numbers"
                  />
                </div>
                {error && <p className="text-sm text-error">{error}</p>}
                <Button type="submit" className="w-full" loading={loading}>
                  Create account
                </Button>
              </form>
              <p className="mt-4 text-sm text-muted-foreground text-center">
                Already have an account?{" "}
                <Link to="/login" className="font-mono text-foreground underline-offset-4 hover:underline">
                  Sign in
                </Link>
              </p>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
