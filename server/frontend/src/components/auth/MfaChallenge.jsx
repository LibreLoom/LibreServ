import { useState, useId, useEffect, useRef } from "react";
import {
  KeyRound,
  Mail,
  Fingerprint,
  Usb,
  ShieldCheck,
  ArrowLeft,
  ChevronRight,
  LifeBuoy,
  RotateCw,
} from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button";
import OtpInput from "../ui/OtpInput";
import IconCircle from "../ui/IconCircle";
import StepTransition from "../common/StepTransition";
import { useSmoothResize } from "../../hooks/useSmoothResize";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import { bufToB64url, prepareRequestOptions } from "../../utils/webauthn";

const MFA_STEPS = ["selection", "entry", "webauthn", "recovery"];

// RESEND_COOLDOWN_S matches the backend's email-OTP send budget (3/min per
// user) — resends wait this long before another code can be requested.
const RESEND_COOLDOWN_S = 30;

const METHOD_META = {
  totp: {
    icon: KeyRound,
    label: "Authenticator app",
    hint: "Enter the 6-digit code from your app.",
  },
  email: {
    icon: Mail,
    label: "Email code",
    hint: "We'll send a code to your email.",
  },
  passkey: {
    icon: Fingerprint,
    label: "Passkey",
    hint: "Use a saved passkey on this device.",
  },
  security_key: {
    icon: Usb,
    label: "Security key",
    hint: "Plug in your security key.",
  },
};

export default function MfaChallenge({ mfaToken, methods, email, onSuccess, onBack }) {
  const { mfaChallenge, mfaVerify, mfaRecover } = useAuth();
  const { addToast } = useToast();
  const [selected, setSelected] = useState(null); // method type, or "recovery"
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Tick down the email resend cooldown once a second.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const handleResend = () => {
    setResendCooldown(RESEND_COOLDOWN_S);
    startEmail();
  };

  // Email OTP: ask the backend to send a fresh code when the user picks the
  // email method (the code entry screen then expects that code).
  async function startEmail() {
    setLoading(true);
    try {
      await mfaChallenge(mfaToken, "email");
    } catch {
      addToast({ type: "error", message: "We couldn't send the code to your email. Try another method." });
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(type) {
    if (!code) return;
    setLoading(true);
    try {
      await mfaVerify(mfaToken, type, { code });
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch (err) {
      if (err?.cause?.status === 401) {
        addToast({ type: "error", message: "That code didn't work. Try again." });
      } else if (!navigator.onLine) {
        addToast({ type: "error", message: "You're offline. Check your connection and try again." });
      } else {
        addToast({ type: "error", message: "Something went wrong. Try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  // WebAuthn (passkey / security key): get an assertion from the authenticator
  // and submit it. The backend (agent-692b7a0a) issues the challenge.
  async function verifyWebAuthn(type) {
    setLoading(true);
    try {
      const challengeRes = await mfaChallenge(mfaToken, type);
      const options = challengeRes?.options;
      if (!options) throw new Error("No challenge");
      const cred = await navigator.credentials.get({
        publicKey: prepareRequestOptions(options?.publicKey ?? options),
      });
      const assertion = /** @type {PublicKeyCredential} */ (cred);
      const response = /** @type {AuthenticatorAssertionResponse} */ (assertion?.response);
      const payload = {
        id: assertion?.id,
        rawId: bufToB64url(assertion?.rawId),
        response: {
          authenticatorData: bufToB64url(response?.authenticatorData),
          clientDataJSON: bufToB64url(response?.clientDataJSON),
          signature: bufToB64url(response?.signature),
          userHandle: response?.userHandle ? bufToB64url(response?.userHandle) : undefined,
        },
        type: assertion?.type,
      };
      await mfaVerify(mfaToken, type, { assertion: payload });
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch (err) {
      if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
        addToast({ type: "error", message: "That was cancelled or we couldn't find your device. Try again or choose another method." });
      } else if (!navigator.onLine) {
        addToast({ type: "error", message: "You're offline. Check your connection and try again." });
      } else {
        addToast({ type: "error", message: "We couldn't verify that device. Try another method." });
      }
    } finally {
      setLoading(false);
    }
  }

  async function recover() {
    if (!code) return;
    setLoading(true);
    try {
      await mfaRecover(mfaToken, code.trim());
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch (err) {
      if (err?.cause?.status === 401) {
        addToast({ type: "error", message: "That recovery code didn't work." });
      } else if (!navigator.onLine) {
        addToast({ type: "error", message: "You're offline. Check your connection and try again." });
      } else {
        addToast({ type: "error", message: "Something went wrong. Try again." });
      }
    } finally {
      setLoading(false);
    }
  }

  // --- Selection screen ---
  if (!selected) {
    return (
      <StepTransition step="selection" order={MFA_STEPS}>
        <div data-slot="auth-mfa-selection" className="space-y-4">
        <div className="flex items-center gap-3">
          <IconCircle icon={ShieldCheck} size="sm" variant="accent" />
          <div>
            <h2 className="font-mono text-lg text-primary">Two-step verification</h2>
            <p className="text-xs text-accent">Pick how you'd like to confirm it's you.</p>
          </div>
        </div>

        <ul className="space-y-2">
          {methods.map((m) => {
            const meta = METHOD_META[m.type] || {
              icon: ShieldCheck,
              label: m.label || m.type,
            };
            const Icon = meta.icon;
            const isWebAuthn = m.type === "passkey" || m.type === "security_key";
            return (
              <li key={m.type}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(m.type);
                    setCode("");
                    if (m.type === "email") {
                      setResendCooldown(RESEND_COOLDOWN_S);
                      startEmail();
                    } else if (isWebAuthn) verifyWebAuthn(m.type);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-large-element bg-primary text-secondary border-2 border-secondary/10 hover:border-accent motion-safe:transition-all text-left group"
                >
                  <Icon size={18} className="text-accent shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm">{meta.label}</span>
                    {meta.hint && (
                      <span className="block text-xs text-accent mt-0.5">{meta.hint}</span>
                    )}
                  </span>
                  <ChevronRight
                    size={16}
                    className="text-accent shrink-0 group-hover:translate-x-0.5 motion-safe:transition-transform"
                  />
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setSelected("recovery");
              setCode("");
            }}
            className="flex items-center gap-2 text-xs text-accent hover:text-primary motion-safe:transition-colors"
          >
            <LifeBuoy size={14} />
            Use a recovery code instead
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 text-xs text-accent hover:text-primary motion-safe:transition-colors"
            >
              <ArrowLeft size={12} /> Back to password
            </button>
          )}
        </div>
        </div>
      </StepTransition>
    );
  }

  // --- Recovery code entry ---
  // Recovery codes are variable-length freeform strings, not fixed-width OTPs,
  // so they use the plain text input (EntryShell with no maxLength).
  if (selected === "recovery") {
    return (
      <StepTransition step="recovery" order={MFA_STEPS}>
        <EntryShell
          title="Recovery code"
          hint="Enter one of your recovery codes."
          onBack={() => setSelected(null)}
          onSubmit={recover}
          loading={loading}
          disabled={!code}
          code={code}
          setCode={setCode}
          placeholder="Enter a recovery code"
          autoFocus
        />
      </StepTransition>
    );
  }

  // --- Code entry (TOTP / email) ---
  const meta = METHOD_META[selected] || { label: selected };
  const isWebAuthn = selected === "passkey" || selected === "security_key";
  if (isWebAuthn) {
    // WebAuthn flows directly from selection (no code field); show a retry.
    const Icon = meta.icon || Fingerprint;
    return (
      <StepTransition step="webauthn" order={MFA_STEPS}>
        <div data-slot="auth-mfa-webauthn" className="space-y-4 text-primary">
        <div className="flex items-center gap-3">
          <IconCircle icon={Icon} size="sm" variant="accent" />
          <div>
            <h2 className="font-mono text-lg">{meta.label}</h2>
            <p className="text-xs text-accent">Waiting for your {meta.label.toLowerCase()}…</p>
          </div>
        </div>
        <div className="flex items-center gap-4 pt-1">
          <button
            type="button"
            onClick={() => verifyWebAuthn(selected)}
            disabled={loading}
            className="text-xs text-accent hover:text-primary motion-safe:transition-colors"
          >
            {loading ? "Checking…" : "Try again"}
          </button>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex items-center gap-1 text-xs text-accent hover:text-primary motion-safe:transition-colors"
          >
            <ArrowLeft size={12} /> Choose another method
          </button>
        </div>
        </div>
      </StepTransition>
    );
  }
  const entryHint =
    selected === "email"
      ? "Check your email for the code we just sent."
      : METHOD_META[selected]?.hint || "Enter the code to continue.";
  return (
    <StepTransition step="entry" order={MFA_STEPS}>
      <EntryShell
        title={meta.label}
        hint={entryHint}
        onBack={() => setSelected(null)}
        onSubmit={() => verifyCode(selected)}
        loading={loading}
        disabled={!code}
        code={code}
        setCode={setCode}
        maxLength={6}
        autoFocus
        email={selected === "email" ? email : undefined}
        resendCooldown={resendCooldown}
        onResend={handleResend}
      />
    </StepTransition>
  );
}

/**
 * @param {{
 *   title?: string,
 *   hint?: string,
 *   onBack?: () => void,
 *   onSubmit?: () => void,
 *   loading?: boolean,
 *   disabled?: boolean,
 *   code?: string,
 *   setCode?: (v: string) => void,
 *   placeholder?: string,
 *   maxLength?: number,
 *   autoFocus?: boolean,
 *   email?: string,
 *   resendCooldown?: number,
 *   onResend?: () => void,
 * } | undefined} [props]
 */
function EntryShell({ title, hint, onBack, onSubmit, loading, disabled, code, setCode, placeholder, maxLength, autoFocus, email, resendCooldown = 0, onResend } = {}) {
  const inputId = useId();
  const isOtp = typeof maxLength === "number";
  const emailPillRef = useRef(null);
  // The email pill's width changes as the resend countdown ticks — animate the
  // x-resize with the same M3 easing used across the design system.
  useSmoothResize(emailPillRef);
  return (
    <form
      data-slot="auth-mfa-entry"
      aria-busy={loading}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4 text-primary"
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-accent hover:text-primary motion-safe:transition-colors"
      >
        <ArrowLeft size={12} /> Choose another method
      </button>

      <div>
        <label htmlFor={inputId} className="block font-mono text-lg text-primary">{title}</label>
        {hint && <p className="text-xs text-accent mt-0.5">{hint}</p>}
      </div>

      {email && (
        <div ref={emailPillRef} className="inline-flex max-w-full flex-wrap items-center rounded-pill bg-accent text-primary text-xs border border-accent/40">
          <span className="flex items-center gap-1.5 whitespace-nowrap bg-primary text-secondary rounded-pill py-1.5 pl-3 pr-2.5">
            <Mail size={12} className="text-accent shrink-0" /> Code sent to {email}
          </span>
          <button
            type="button"
            onClick={onResend}
            disabled={resendCooldown > 0 || loading}
            className="flex items-center gap-1 whitespace-nowrap text-xs py-1.5 pl-2.5 pr-3 rounded-r-pill text-primary enabled:hover:underline underline-offset-2 motion-safe:transition-colors disabled:opacity-50"
          >
            <RotateCw size={11} /> {resendCooldown > 0 ? `Resend (${resendCooldown}s)` : "Resend"}
          </button>
        </div>
      )}

      {isOtp ? (
        <OtpInput
          id={inputId}
          value={code}
          onChange={setCode}
          maxLength={maxLength}
          disabled={loading}
          autoFocus={autoFocus}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 border-2 border-primary/30 rounded-pill bg-primary text-secondary placeholder:text-secondary/50 focus:ring-2 focus:ring-accent focus:ring-offset-2"
          autoFocus={autoFocus}
        />
      )}

      <Button type="submit" disabled={loading || disabled} fullWidth>
        {loading ? "Verifying…" : "Verify"}
      </Button>
    </form>
  );
}

MfaChallenge.propTypes = {
  mfaToken: PropTypes.string.isRequired,
  methods: PropTypes.arrayOf(
    PropTypes.shape({ type: PropTypes.string, label: PropTypes.string }),
  ).isRequired,
  email: PropTypes.string,
  onSuccess: PropTypes.func.isRequired,
  onBack: PropTypes.func,
};

EntryShell.propTypes = {
  title: PropTypes.string,
  hint: PropTypes.string,
  onBack: PropTypes.func,
  onSubmit: PropTypes.func,
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  code: PropTypes.string,
  setCode: PropTypes.func,
  placeholder: PropTypes.string,
  maxLength: PropTypes.number,
  email: PropTypes.string,
  resendCooldown: PropTypes.number,
  onResend: PropTypes.func,
};