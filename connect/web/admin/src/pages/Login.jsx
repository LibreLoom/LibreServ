import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon } from "lucide-react";

export default function Login() {
  const { login, seedAdmin, loading } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (mode === "seed") {
        await seedAdmin(email, password, name);
        setMode("login");
        setError("Admin account created. Please sign in.");
        return;
      }
      const res = await login(email, password, totpCode);
      if (res.requires_2fa) {
        setNeeds2FA(true);
        return;
      }
      navigate("/");
    } catch (err) {
      setError(err.message || "Could not sign in.");
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
          <CardTitle className="text-3xl">Connect Admin</CardTitle>
          <CardDescription>
            {needs2FA
              ? "Enter your authenticator code to continue."
              : mode === "seed"
                ? "Create the first admin account."
                : "Sign in to manage devices, cases, and configuration."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ShakeTarget as="form" shake={error} onSubmit={handleSubmit} className="space-y-4">
            {!needs2FA && (
              <>
                {mode === "seed" && (
                  <div>
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                  </div>
                )}
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoFocus />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "seed" ? "At least 12 characters" : "Enter your password"} />
                </div>
              </>
            )}
            {needs2FA && (
              <div>
                <Label htmlFor="totp">Authenticator Code</Label>
                <Input id="totp" type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="000000" maxLength={6} autoFocus />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {needs2FA ? "Verify" : mode === "seed" ? "Create Admin" : "Sign In"}
            </Button>
          </ShakeTarget>
          {mode === "login" && !needs2FA && (
            <button
              onClick={() => setMode("seed")}
              className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              First time? Create the first admin account
            </button>
          )}
          {mode === "seed" && (
            <button
              onClick={() => setMode("login")}
              className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Back to sign in
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
