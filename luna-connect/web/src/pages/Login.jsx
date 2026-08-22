import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Sun, Moon } from "lucide-react";
import { BrandMark } from "../components/BrandMark.jsx";

export default function Login() {
  const { login } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err.message || "Could not sign in. Check your email and password.");
    } finally {
      setLoading(false);
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
        <CardHeader className="text-center">
          <BrandMark className="mx-auto mb-3 h-12 w-12" />
          <CardTitle className="text-3xl">Luna Connect</CardTitle>
          <CardDescription>Sign in to pair your Luna and keep a spare copy of files off-site.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" />
            </div>
            {error && <p className="text-sm text-error">{error}</p>}
            <Button type="submit" className="w-full" loading={loading}>Sign in</Button>
          </form>
          <p className="mt-4 text-sm text-muted-foreground text-center">
            New here?{" "}
            <Link to="/register" className="font-mono text-foreground underline-offset-4 hover:underline">Create an account</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
