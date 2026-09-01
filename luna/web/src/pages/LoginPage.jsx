import { useMemo, useState } from "react";
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

  const { login } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);

  // Where to send the user after a successful login — the page they were
  // trying to reach, or home.
  const returnTo = location.state?.from?.pathname || "/";

  function calculateErrorHTML() {
    if (errorStatus === 401) {
      return (
        <p>
          It seems that your username or password might be incorrect.
          Double-check to make sure they're right!
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
          Wait up! If you just rebooted, updated, or simply turned on your
          Luna, it may still be starting up. <br />
          <br />
          If this issue has been happening repeatedly, try rebooting your
          Luna (it's not super intuitive for this error, but trust us, it
          can help). <br />
          <br /> If you've rebooted your Luna and continue encountering
          this issue, try contacting support for assistance.
        </p>
      );
    } else if (errorStatus === "NetworkError") {
      return (
        <p>
          Check your device's connection to the internet. (Not Luna's,
          but this device's!) <br />
          <br />
          If you're absolutely sure that you are connected to the internet,
          please try rebooting your Luna. <br />
          <br />
          If you've both rebooted your Luna and have ensured that your
          device is connected to the internet, please reach out to support for
          assistance.{" "}
        </p>
      );
    }
    return (
      <p>
        We've encountered an unidentified error while trying to log in.
        <br />
        <br />
        If you're having this issue repeatedly, start by rebooting your
        Luna. If that fails, feel free to contact support to help resolve
        this issue, we're always happy to help!
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
                Hey there! Log in to continue.
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
