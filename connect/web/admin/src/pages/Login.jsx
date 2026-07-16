import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    setError("");
    try {
      login(token);
      navigate("/");
    } catch {
      setError("Invalid admin token. Check the CONNECT_ADMIN_TOKEN setting.");
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
            Sign in with your admin token to manage devices, cases, and configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="token">Admin Token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter admin token"
                autoFocus
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                This is the admin token configured in your Connect server's auth settings.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Sign In
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
