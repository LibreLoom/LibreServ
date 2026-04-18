import { useRef, useEffect, useState, useMemo } from "react";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../context/ToastContext";
import { login as loginQuips } from "../assets/greetings";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import Alert from "../components/common/Alert";

function getLoginQuip() {
  const hoursSinceEpoch = Math.floor(Date.now() / 43200000);
  return loginQuips[hoursSinceEpoch % loginQuips.length];
}

function ForgotPasswordModal({ isOpen, onClose }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const { addToast } = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || loading) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || "Failed to send reset link");
      }
      
      setSent(true);
      addToast({ type: "success", message: "Check your email for the reset link!" });
    } catch (err) {
      setError(err.message);
      addToast({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <ModalCard title="Reset Password" onClose={onClose}>
      {!sent ? (
        <>
          <p className="text-accent text-sm mb-4">
            Enter your email address and we'll send you a link to reset your password.
          </p>
          <form onSubmit={handleSubmit}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent"
              required
            />
            {error && (
              <Alert variant="error" message={error} className="mb-4" />
            )}
            <Button type="submit" disabled={loading} fullWidth>
              {loading ? "Sending..." : "Send Reset Link"}
            </Button>
          </form>
        </>
      ) : (
        <Alert variant="success" message="Check your email for the reset link!" />
      )}
    </ModalCard>
  );
}

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const errorRef = useRef(null);
  const { login } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);
  
  useEffect(() => {
    if (errorStatus && errorRef.current) {
      errorRef.current.focus();
    }
  }, [errorStatus]);

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
          Please wait a bit before trying again. If you can't remember your
          password, feel free to contact support!
        </p>
      );
    } else if (errorStatus === 500) {
      return (
        <p>
          Wait up! If you just rebooted, updated, or simply turned on your
          LibreServ, it may still be starting up. <br />
          <br />
          If this issue has been happening repeatedly, try rebooting your
          LibreServ (it's not super intuitive for this error, but trust us, it
          can help). <br />
          <br /> If you've rebooted your LibreServ and continue encountering
          this issue, try contacting support for assistance.
        </p>
      );
    } else if (errorStatus === "NetworkError") {
      return (
        <p>
          Check your device's connection to the internet. (Not your LibreServ's,
          but this device's!) <br />
          <br />
          If you're absolutely sure that you are connected to the internet,
          please try rebooting your LibreServ. <br />
          <br />
          If you've both rebooted your LibreServ and have ensured that your
          device is connected to the internet, please reach out to support for
          assistance.{" "}
        </p>
      );
    } else if (errorStatus) {
      return (
        <p>
          We've encountered an unidentified error while trying to log in.
          <br />
          <br />
          If you're having this issue repeatedly, start by rebooting your
          LibreServ. If that fails, feel free to contact support to help resolve
          this issue, we're always happy to help! <br />
          <br />
          See
          <a
            href={
              "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/" +
              errorStatus
            }
            className="underline"
          >
            {" this page "}
          </a>
          for info that might be helpful.
        </p>
      );
    }
  }
  
  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password || loading) return;
    setLoading(true);
    try {
      await login(username, password);
      window.location.reload();
    } catch (err) {
      setErrorStatus(err.cause?.status || "NetworkError");
      setLoading(false);
    }
  }
  
  return (
    <main className="fixed inset-0 grid place-items-center bg-primary px-4" id="main-content" tabIndex={-1}>
      <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in p-8">
        <span className="text-primary font-mono text-2xl block text-center">
          LibreServ
        </span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <span className="text-primary font-mono text-xl font-normal block text-center">
          Hey there! Log in to continue.
        </span>
        <p className="text-accent text-sm text-center mt-2">{loginQuip}</p>
        <form
          onSubmit={handleSubmit}
          aria-busy={loading}
          className="flex flex-col mt-6 rounded-large-element p-4 bg-primary text-secondary"
        >
          <label htmlFor="username" className={`text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1`}>
            Username
          </label>
          <input
            value={username}
            placeholder="e.g. admin"
            id="username"
            onChange={(e) => setUsername(e.target.value)}
            className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 mb-4 focus:ring-2 focus:ring-accent focus:ring-offset-2"
            name="username"
            autoComplete="username"
            aria-invalid={Boolean(errorStatus)}
            aria-describedby={errorStatus ? "login-error" : undefined}
          ></input>
          <label htmlFor="password" className={`text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1`}>
            Password
          </label>
          <input
            value={password}
            placeholder="e.g. hunter2"
            id="password"
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            className="placeholder:text-secondary/60 border-2 border-secondary rounded-pill p-2 focus:ring-2 focus:ring-accent focus:ring-offset-2"
            name="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errorStatus)}
            aria-describedby={errorStatus ? "login-error" : undefined}
          ></input>
          <a
            onClick={() => setShowResetModal(true)}
            className="text-accent text-sm underline mt-2 text-right cursor-pointer"
          >
            Forgot password?
          </a>
          <button
            type="submit"
            className={`bg-secondary text-primary rounded-pill p-2 mt-6 transition-all duration-300 ease-out hover:bg-primary hover:text-secondary hover:ring-accent hover:ring-2 disabled:bg-accent disabled:cursor-not-allowed disabled:ring-0`}
            disabled={loading}
            aria-busy={loading}
          >
            <span className="flex items-center justify-center">
              <span className="sr-only">{loading ? "Logging in, please wait" : ""}</span>
              <span className={`overflow-hidden transition-all duration-300 ease-out ${loading ? "w-5 mr-1" : "w-0"}`} aria-hidden="true">
                <span className="inline-block w-4 h-4 border-2 border-primary border-t-primary rounded-full animate-spin"></span>
              </span>
              <span>Login</span>
            </span>
          </button>
          <div
            className={`text-accent overflow-hidden transition-all duration-300 ease-in-out ${errorStatus ? "mt-4 max-h-96 opacity-100" : "max-h-0 opacity-0"}`}
            role="alert"
            aria-live="assertive"
            ref={errorRef}
            tabIndex={-1}
            id="login-error"
          >
            {errorStatus && calculateErrorHTML()}
          </div>
        </form>
      </div>
      
      <ForgotPasswordModal isOpen={showResetModal} onClose={() => setShowResetModal(false)} />
    </main>
  );
}
