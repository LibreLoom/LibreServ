import { cn } from "@/lib/utils";
import { useEffect, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PropTypes from "prop-types";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../context/ToastContext";
import { login as loginQuips } from "../assets/greetings";
import api from "../lib/api";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import StepTransition from "../components/common/StepTransition";
import Button from "../components/ui/Button";
import FormInput from "../components/common/forms/FormInput";
import Alert from "../components/common/Alert";
import MfaChallenge from "../components/auth/MfaChallenge";
import { useSettingsStatus } from "../hooks/useSettingsStatus";

const LOGIN_STEPS = ["form", "mfa"];

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
      const res = await api("/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || "Failed to send reset link");
      }
      
      setSent(true);
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
          <p className="text-primary/70 text-sm mb-4">
            Enter your email address and we'll send you a link to reset your password.
          </p>
          <form onSubmit={handleSubmit}>
            <FormInput
              label="Email"
              name="reset-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              surface="secondary"
              error={error}
              shake={error}
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

export default function Login({ embedded = false, returnTo = "/", onLoginSuccess, notice, noticeDetail }) {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const [mfa, setMfa] = useState(null);
  
  const { login, me } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);
  const { smtpConfigured } = useSettingsStatus();

  // OIDC login flow: when the OIDC provider redirects here with
  // ?auth_request_id=<id>, we complete the flow after successful login by
  // redirecting to /authorize/callback?id=<id> (handled by the OIDC
  // provider on the backend, not the SPA).
  const authRequestId = searchParams.get("auth_request_id");

  /**
   * After a successful login (or MFA), decide where to send the user.
   * If this is an OIDC flow, redirect to the provider's callback.
   * Otherwise, navigate to the returnTo path or call onLoginSuccess.
   */
  function completeLogin() {
    if (authRequestId) {
      // Full-page navigation — /authorize/callback is served by the OIDC
      // provider, not the SPA router.
      window.location.href = `/authorize/callback?id=${authRequestId}`;
      return;
    }
    if (onLoginSuccess) {
      onLoginSuccess();
    } else {
      navigate(returnTo);
    }
  }

  

  // If the user is already logged in and this is an OIDC flow, skip the
  // login form and redirect straight to the OIDC callback.
  useEffect(() => {
    if (me && authRequestId) {
      window.location.href = `/authorize/callback?id=${authRequestId}`;
    }
  }, [me, authRequestId]);

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
      const statusNum = Number(errorStatus);
      if (!Number.isInteger(statusNum) || statusNum < 100 || statusNum > 599) {
        return (
          <p>
            We've encountered an unidentified error while trying to log in.
            <br />
            <br />
            If you're having this issue repeatedly, start by rebooting your
            LibreServ. If that fails, feel free to contact support to help resolve
            this issue, we're always happy to help!
          </p>
        );
      }
      return (
        <p>
          We've encountered an unidentified error while trying to log in.
          <br />
          <br />
          If you're having this issue repeatedly, start by rebooting your
          LibreServ. If that fails, feel free to contact support to help resolve
          this issue, we're always happy to help!
        </p>
      );
    }
  }
  
  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password || loading) return;
    setLoading(true);
    try {
      const result = await login(username, password);
      if (result.status === "mfa_required") {
        setMfa({ mfaToken: result.mfaToken, methods: result.methods, email: result.email });
        setLoading(false);
      } else {
        // MfaChallenge raises this itself on its own success paths, so only
        // the direct (no second factor) sign-in needs it here.
        addToast({ type: "success", message: "Signed in." });
        completeLogin();
      }
    } catch (err) {
      setErrorStatus(err.cause?.status || "NetworkError");
      setLoading(false);
    }
  }
  
  return (
    <main
        data-slot="login-page"
        className={cn(embedded ? "w-full" : "fixed inset-0 grid place-items-center bg-primary px-4")}
        id="main-content"
        tabIndex={-1}
      >
      <div className={cn(embedded ? "w-full" : "w-full max-w-lg rounded-large-element")}>
        <Card surface="secondary" padding={false}>
          <div className="p-8">
            <span className="text-primary font-mono text-2xl block text-center">
              LibreServ
            </span>
            <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
            <StepTransition step={mfa ? "mfa" : "form"} order={LOGIN_STEPS}>
              {!mfa && (
                notice ? (
                  <>
                    <span className="text-primary font-mono text-xl font-normal block text-center">
                      {notice}
                    </span>
                    {noticeDetail && (
                      <p className="text-primary/80 text-sm text-center mt-2">{noticeDetail}</p>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-primary font-mono text-xl font-normal block text-center">
                      Hey there! Log in to continue.
                    </span>
                    <p className="text-primary/80 text-sm text-center mt-2">{loginQuip}</p>
                  </>
                )
              )}
              {mfa ? (
          <MfaChallenge
            mfaToken={mfa.mfaToken}
            methods={mfa.methods}
            email={mfa.email}
            onSuccess={completeLogin}
            onBack={() => {
              setMfa(null);
              setPassword("");
            }}
          />
        ) : (
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
          {smtpConfigured && (
            <a
              onClick={() => setShowResetModal(true)}
              className="text-secondary/80 text-sm underline mt-2 text-right cursor-pointer"
            >
              Forgot password?
            </a>
          )}
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
            className={cn(`text-secondary/80 overflow-hidden transition-all duration-300 ease-in-out`, errorStatus ? "mt-4 max-h-96 opacity-100" : "max-h-0 opacity-0")}
            role="alert"
            aria-live="assertive"
            id="login-error"
          >
            {errorStatus && calculateErrorHTML()}
          </div>
          </div>
        </form>
              )}
            </StepTransition>
          </div>
        </Card>
      </div>
      {!embedded && (
        <ForgotPasswordModal isOpen={showResetModal} onClose={() => setShowResetModal(false)} />
      )}
    </main>
  );
}
Login.propTypes = {
  embedded: PropTypes.bool,
  returnTo: PropTypes.string,
  onLoginSuccess: PropTypes.func,
  notice: PropTypes.string,
  noticeDetail: PropTypes.string,
};
Login.defaultProps = {
  embedded: false,
  returnTo: "/",
  onLoginSuccess: undefined,
  notice: undefined,
  noticeDetail: undefined,
};
