import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon, MailOpen } from "lucide-react";

export default function Register() {
  const { register, loading } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [showVerify, setShowVerify] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState("");
  const [resendState, setResendState] = useState("idle"); // idle | sending | sent

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const res = await register(email, password, name, username);
      setRegisteredEmail(res.email || email);
      setShowVerify(true);
    } catch (err) {
      setError(err.message || "Could not create account.");
    }
  };

  const handleResend = async () => {
    if (resendState === "sending") return;
    setError("");
    setResendState("sending");
    try {
      await api.resendVerification("");
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 3000);
    } catch (err) {
      setError(err.message || "We couldn't send the verification email. Try again in a moment.");
      setResendState("idle");
    }
  };

  // After signup the account is locked until the email is confirmed, so swap
  // the form for a "check your inbox" screen. The "I've verified" button just
  // links back to the signup page — verification itself happens via the email
  // link, which lands on /verify-email.
  if (showVerify) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <button
          onClick={toggle}
          className="absolute top-4 right-4 rounded-pill p-2 text-muted-foreground hover:bg-accent transition-colors"
        >
          <Sun className="h-5 w-5 dark:hidden" />
          <Moon className="h-5 w-5 hidden dark:block" />
        </button>

        <Card className="w-full max-w-md animate-pop-in">
          <CardHeader className="text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <MailOpen className="h-6 w-6 text-foreground" strokeWidth={1.75} />
            </div>
            <CardTitle className="text-3xl">Verify your email</CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              We sent a verification link to{" "}
              <span className="font-mono text-foreground">{registeredEmail}</span>. Click the
              link in the email to confirm your address — your account stays locked until you do.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" size="lg" onClick={() => navigate("/register")}>
              I've verified
            </Button>
            <div className="text-center">
              <button
                type="button"
                onClick={handleResend}
                disabled={resendState !== "idle"}
                className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground motion-safe:transition-colors"
              >
                {resendState === "sending"
                  ? "Sending…"
                  : resendState === "sent"
                  ? "Email resent — check your inbox"
                  : "Resend Verification Email"}
              </button>
              <p className="mt-2 text-xs text-muted-foreground">
                Check your spam or junk folder too — it sometimes lands there.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <button
        onClick={toggle}
        className="absolute top-4 right-4 rounded-pill p-2 text-muted-foreground hover:bg-accent transition-colors"
      >
        <Sun className="h-5 w-5 dark:hidden" />
        <Moon className="h-5 w-5 hidden dark:block" />
      </button>

      <Card className="w-full max-w-md animate-pop-in">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">Create Account</CardTitle>
          <CardDescription>
            Create a Connect account to manage your LibreServ devices and subscription.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="your-name"
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                When your apps send email, the from address will be{" "}
                <span className="font-mono text-foreground">{username || "your-name"}-u@resend.libreloom.org</span>.
                Letters, numbers, and hyphens (3-30 characters).
              </p>
            </div>
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
            <ShakeTarget shake={error}>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Use at least 8 characters. We recommend a mix of letters, numbers, and symbols.
                </p>
              </div>
            </ShakeTarget>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Create Account
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-foreground underline">Sign In</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
