import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon } from "lucide-react";

export default function Register() {
  const { register, loading } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await register(email, password, name);
      navigate("/login");
    } catch (err) {
      setError(err.message || "Could not create account.");
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
                placeholder="At least 8 characters"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Use at least 8 characters. We recommend a mix of letters, numbers, and symbols.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Create Account
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-foreground underline">Sign in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
