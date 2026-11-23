import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { login as loginQuips } from "../lib/greetings.jsx";
import { perfCancel, perfStart } from "../lib/perf.js";
import { prefetchDashboard } from "../lib/dashboardData.js";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import StepTransition from "@libreloom/ui/components/common/StepTransition.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { shakeElement } from "@libreloom/ui/utils/shake.js";
import FormInput from "../components/common/forms/FormInput";
import usePageTitle from "../hooks/usePageTitle.js";

const LOGIN_STEPS = ["form"];

// One "signed out" toast per ended session. AuthContext bumps a generation
// counter on every confirmed death, so signing in and dying again announces
// the new death too, while StrictMode's double effect on one death does not.
// Lives outside the component so a remount can't announce the same death twice.
let lastAnnouncedSessionEnd = -1;

function getLoginQuip() {
  const hoursSinceEpoch = Math.floor(Date.now() / 43200000);
  return loginQuips[hoursSinceEpoch % loginQuips.length];
}

export default function LoginPage({ unreachable = false }) {
  usePageTitle("Sign in");
  const { addToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const [fieldErrors, setFieldErrors] = useState(/** @type {{ username?: string, password?: string }} */ ({}));

  const { login, hasAdmin, loading: authLoading, sessionEnded, sessionEndGeneration } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);

  useEffect(() => {
    if (!authLoading && hasAdmin === false) {
      navigate("/setup", { replace: true });
    }
  }, [authLoading, hasAdmin, navigate]);

  // Landed here because the session ended mid-use (password changed,
  // signed out elsewhere) — say so instead of a silent bounce. The generation
  // makes a second death in the same page session announce itself again.
  useEffect(() => {
    if (!sessionEnded) return;
    if (lastAnnouncedSessionEnd === sessionEndGeneration) return;
    lastAnnouncedSessionEnd = sessionEndGeneration;
    addToast({
      type: "info",
      message: "Your session ended, so you were signed out. Sign in again to keep going.",
    });
  }, [sessionEnded, sessionEndGeneration, addToast]);

  // Where to send the user after a successful login — the page they were
  // trying to reach, or home.
  const returnTo = location.state?.from?.pathname || "/";
  // RequireAuth renders this page in place of the page you were on, so the URL
  // never moves to /login. Signing in then just swaps your page back in; only
  // the real /login route needs to navigate anywhere.
  const inPlace = location.pathname !== "/login";

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
          Too many sign-in tries. Wait a few minutes, then try again.
        </p>
      );
    } else if (errorStatus === 502 || errorStatus === 503 || errorStatus === 504) {
      return (
        <p>
          Luna is not answering. If Luna just turned on or updated, wait a
          minute and try again.
        </p>
      );
    } else if (errorStatus === "NetworkError") {
      return (
        <p>
          This device cannot reach Luna. Check its connection, or wait a
          minute if Luna just turned on.
        </p>
      );
    }
    return (
      <p>
        Luna could not sign you in. Try again, and if it keeps failing, turn
        Luna off and on again.
      </p>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    /** @type {{ username?: string, password?: string }} */
    const missing = {};
    if (!username.trim()) missing.username = "Enter your username.";
    if (!password) missing.password = "Enter your password.";
    if (missing.username || missing.password) {
      setErrorStatus(null);
      // A field that already shows its error shakes on its own only when the
      // error first appears, so shake again by hand on every repeat click.
      for (const name of Object.keys(missing)) {
        if (fieldErrors[name]) {
          const input = e.currentTarget.querySelector(`#${name}`);
          shakeElement(name === "password" ? input?.parentElement : input);
        }
      }
      setFieldErrors(missing);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    // W3 (luna/perf): ends when the Dashboard is usable.
    perfStart("W3", { fromInput: true });
    try {
      const me = await login(username.trim(), password);
      // Headed for the Dashboard: ask for its data now, while its page renders.
      if ((inPlace ? location.pathname : returnTo) === "/") prefetchDashboard(queryClient, me);
      addToast({ type: "success", message: "Signed in." });
      if (!inPlace) navigate(returnTo, { replace: true });
    } catch (err) {
      perfCancel("W3");
      setErrorStatus(err.status || "NetworkError");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      data-slot="login-page"
      className="fixed inset-0 grid place-items-center surface-primary px-4"
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
              <p className="text-primary text-sm text-center mt-2">{loginQuip}</p>
              {unreachable ? (
                <PageNotice variant="info" surface="secondary" className="mt-6">
                  Can't reach Luna right now. It may be restarting after an update. Trying again…
                </PageNotice>
              ) : (
                <form
                  noValidate
                  onSubmit={handleSubmit}
                  aria-busy={loading}
                  className="flex flex-col mt-6"
                >
                  <div className="rounded-large-element p-4 surface-primary flex flex-col">
                  <FormInput
                    label="Username"
                    name="username"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setFieldErrors((f) => (f.username ? { ...f, username: undefined } : f));
                    }}
                    placeholder="e.g. admin"
                    autoComplete="username"
                    surface="primary"
                    error={fieldErrors.username}
                  />
                  <FormInput
                    label="Password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setFieldErrors((f) => (f.password ? { ...f, password: undefined } : f));
                    }}
                    placeholder="e.g. hunter2"
                    autoComplete="current-password"
                    surface="primary"
                    error={fieldErrors.password}
                    shake={errorStatus}
                    loading={loading}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    surface="primary"
                    fullWidth
                    loading={loading}
                    className="mt-6"
                  >
                    Sign in
                  </Button>
                  <div
                    className={
                      "text-secondary overflow-hidden transition-all duration-300 ease-in-out " +
                      (errorStatus ? "mt-4 max-h-96 opacity-100" : "max-h-0 opacity-0")
                    }
                    role="alert"
                    aria-live="assertive"
                    id="login-error"
                  >
                    {errorStatus && calculateErrorHTML()}
                  </div>
                  <p className="mt-5 text-center text-sm">
                    Forgot your password? <Link className="underline decoration-accent underline-offset-4" to="/recover">Create a USB recovery file</Link> to use at startup.
                  </p>
                  </div>
                </form>
              )}
            </StepTransition>
          </div>
        </Card>
      </div>
    </main>
  );
}
