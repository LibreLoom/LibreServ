import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { login as loginQuips } from "../assets/greetings";
import Card from "../components/cards/Card";
import StepTransition from "../components/common/StepTransition";
import Button from "../components/ui/Button";
import FormInput from "../components/common/forms/FormInput";

const LOGIN_STEPS = ["form"];

function getLoginQuip() {
  const hoursSinceEpoch = Math.floor(Date.now() / 43200000);
  return loginQuips[hoursSinceEpoch % loginQuips.length];
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);

  const { login, hasAdmin, loading: authLoading } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);

  useEffect(() => {
    if (!authLoading && hasAdmin === false) {
      navigate("/setup", { replace: true });
    }
  }, [authLoading, hasAdmin, navigate]);

  // Where to send the user after a successful login — the page they were
  // trying to reach, or home.
  const returnTo = location.state?.from?.pathname || "/";

  // TODO: in luna web website, need wizard that asks users a set of questions, then gives them a pwreset-<device_token>.luna file to put onto the root of a flashdrive.

  function calculateErrorHTML() {
    if (errorStatus === 401) {
      return (
        <p>
          That username or password is wrong. Try again.
        </p>
      );
    } else if (errorStatus === 429) {
      return (
        <p>
          Too many tries from this device. Wait a few minutes, then try again.
        </p>
      );
    } else if (errorStatus === 500) {
      return (
        <p>
          Luna may still be starting after a power-on or update. Wait a minute
          and try again. If this keeps happening, power Luna off and on once,
          then contact support.
        </p>
      );
    } else if (errorStatus === "NetworkError") {
      return (
        <p>
          This phone or computer cannot reach Luna. Check that it is on the
          same Wi‑Fi or network as Luna, then try again. If Luna just powered
          on, wait a minute and try once more.
        </p>
      );
    }
    return (
      <p>
        Sign-in failed. Try again. If it keeps failing, power Luna off and on
        once, then contact support.
      </p>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password || loading) return;
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setErrorStatus(err.status || "NetworkError");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      data-slot="login-page"
      className="fixed inset-0 grid place-items-center bg-primary px-4"
      id="main-content"
      tabIndex={-1}
    >
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div className="w-full max-w-lg rounded-large-element">
        <Card surface="secondary" padding={false}>
          <div className="p-8">
            <span className="text-primary font-mono text-2xl block text-center">
              Luna
            </span>
            <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
            <StepTransition step="form" order={LOGIN_STEPS}>
              <span className="text-primary font-mono text-xl font-normal block text-center">
                Sign in to continue.
              </span>
              <p className="text-primary/80 text-sm text-center mt-2">{loginQuip}</p>
              <form
                onSubmit={handleSubmit}
                aria-busy={loading}
                className="flex flex-col mt-6"
              >
                <div className="rounded-large-element p-4 bg-primary text-secondary flex flex-col">
                <FormInput
                  label="Username"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. admin"
                  autoComplete="username"
                  surface="primary"
                  aria-invalid={Boolean(errorStatus)}
                  aria-describedby={errorStatus ? "login-error" : undefined}
                />
                <FormInput
                  label="Password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="e.g. hunter2"
                  autoComplete="current-password"
                  surface="primary"
                  shake={errorStatus}
                  loading={loading}
                  aria-invalid={Boolean(errorStatus)}
                  aria-describedby={errorStatus ? "login-error" : undefined}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  surface="primary"
                  fullWidth
                  loading={loading}
                  className="mt-6"
                >
                  Login
                </Button>
                <div
                  className={
                    "text-secondary/80 overflow-hidden transition-all duration-300 ease-in-out " +
                    (errorStatus ? "mt-4 max-h-96 opacity-100" : "max-h-0 opacity-0")
                  }
                  role="alert"
                  aria-live="assertive"
                  id="login-error"
                >
                  {errorStatus && calculateErrorHTML()}
                </div>
                </div>
              </form>
            </StepTransition>
          </div>
        </Card>
      </div>
    </main>
  );
}
