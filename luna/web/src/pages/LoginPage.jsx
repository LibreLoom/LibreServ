import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate(location.state?.from?.pathname || "/", { replace: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <Page title="You're signed in" titleId="login-title">
        <TextLink to="/">Open Luna</TextLink>
      </Page>
    );
  }

  return (
    <Page title="Welcome back" titleId="login-title">
      <Card noPopIn noHeightAnim className="max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-primary text-xs">Username</span>
            <input
              className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              value={username}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-primary text-xs">Password</span>
            <input
              type="password"
              className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="text-error text-xs">{error}</p>}
          <Button type="submit" variant="secondary" fullWidth loading={busy}>
            Sign in
          </Button>
        </form>
      </Card>
      <p className="text-secondary text-xs mt-4">
        First time here? <TextLink to="/setup">Set up Luna</TextLink>
      </p>
    </Page>
  );
}
