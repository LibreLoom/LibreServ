import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon } from "lucide-react";

export default function Login() {
  const { login, loading } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const res = await login(email, password, totpCode);
      if (res.requires_2fa) {
        setNeeds2FA(true);
        return;
      }
      navigate("/");
    } catch (err) {
      setError(err.message || "Could not sign in. Check your email and password.");
    }
  };

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
          <CardTitle className="text-3xl">LibreServ Connect</CardTitle>
          <CardDescription>
            {needs2FA
              ? "Enter your authenticator code to continue."
              : "Sign in to manage your subscription and devices."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!needs2FA && (
              <>
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
                    placeholder="Enter your password"
                  />
                </div>
              </>
            )}
            {needs2FA && (
              <div>
                <Label htmlFor="totp">Authenticator Code</Label>
                <Input
                  id="totp"
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  maxLength={6}
                  autoFocus
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {needs2FA ? "Verify" : "Sign In"}
            </Button>
          </form>
          {!needs2FA && (
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <Link to="/register" className="text-foreground underline">Create one</Link>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
