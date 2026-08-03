import { useState, useId } from "react";
import {
  KeyRound,
  Mail,
  Fingerprint,
  Usb,
  ShieldCheck,
  ArrowLeft,
  LifeBuoy,
} from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button";
import Alert from "../common/Alert";
import OtpInput from "../ui/OtpInput";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import { bufToB64url, prepareRequestOptions } from "../../utils/webauthn";

const METHOD_META = {
  totp: { icon: KeyRound, label: "Authenticator app" },
  email: { icon: Mail, label: "Email code" },
  passkey: { icon: Fingerprint, label: "Passkey" },
  security_key: { icon: Usb, label: "Security key" },
};

export default function MfaChallenge({ mfaToken, methods, email, onSuccess, onBack }) {
  const { mfaChallenge, mfaVerify, mfaRecover } = useAuth();
  const { addToast } = useToast();
  const [selected, setSelected] = useState(null); // method type, or "recovery"
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Email OTP: ask the backend to send a fresh code when the user picks the
  // email method (the code entry screen then expects that code).
  async function startEmail() {
    setLoading(true);
    setError(null);
    try {
      await mfaChallenge(mfaToken, "email");
    } catch {
      setError("We couldn't send the code to your email. Try another method.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(type) {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      await mfaVerify(mfaToken, type, { code });
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch (err) {
      if (err?.cause?.status === 401) {
        setError("That code didn't work. Try again.");
      } else if (!navigator.onLine) {
        setError("You're offline. Check your connection and try again.");
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // WebAuthn (passkey / security key): get an assertion from the authenticator
  // and submit it. The backend (agent-692b7a0a) issues the challenge.
  async function verifyWebAuthn(type) {
    setLoading(true);
    setError(null);
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
        setError("That was cancelled or we couldn't find your device. Try again or choose another method.");
      } else if (!navigator.onLine) {
        setError("You're offline. Check your connection and try again.");
      } else {
        setError("We couldn't verify that device. Try another method.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function recover() {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      await mfaRecover(mfaToken, code.trim());
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch (err) {
      if (err?.cause?.status === 401) {
        setError("That recovery code didn't work.");
      } else if (!navigator.onLine) {
        setError("You're offline. Check your connection and try again.");
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // --- Selection screen ---
  if (!selected) {
    return (
      <div data-slot="auth-mfa-selection" className="space-y-4">
        <div className="flex items-center gap-2 text-primary">
          <ShieldCheck size={18} className="text-accent" />
          <p className="text-sm">Verify it's you — pick a way to continue.</p>
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
                    setError(null);
                    if (m.type === "email") startEmail();
                    else if (isWebAuthn) verifyWebAuthn(m.type);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-large-element border-2 border-primary/30 hover:border-accent hover:ring-2 hover:ring-accent motion-safe:transition-all text-primary"
                >
                  <Icon size={18} className="text-accent shrink-0" />
                  <span className="text-sm">{meta.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => {
            setSelected("recovery");
            setCode("");
            setError(null);
          }}
          className="w-full flex items-center justify-center gap-2 text-xs text-accent hover:text-primary motion-safe:transition-colors"
        >
          <LifeBuoy size={14} />
          Use a recovery code instead
        </button>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary"
          >
            <ArrowLeft size={12} /> Back to password
          </button>
        )}
        {error && <Alert variant="error" message={error} />}
      </div>
    );
  }

  // --- Recovery code entry ---
  // Recovery codes are variable-length freeform strings, not fixed-width OTPs,
  // so they use the plain text input (EntryShell with no maxLength).
  if (selected === "recovery") {
    return (
      <EntryShell
        title="Recovery code"
        onBack={() => setSelected(null)}
        onSubmit={recover}
        loading={loading}
        disabled={!code}
        error={error}
        code={code}
        setCode={setCode}
        placeholder="Enter a recovery code"
        autoFocus
      />
    );
  }

  // --- Code entry (TOTP / email) ---
  const meta = METHOD_META[selected] || { label: selected };
  const isWebAuthn = selected === "passkey" || selected === "security_key";
  if (isWebAuthn) {
    // WebAuthn flows directly from selection (no code field); show a retry.
    return (
      <div data-slot="auth-mfa-webauthn" className="space-y-3 text-primary">
        <p className="text-sm">Waiting for your {meta.label.toLowerCase()}…</p>
        {error && <Alert variant="error" message={error} />}
        <button
          type="button"
          onClick={() => verifyWebAuthn(selected)}
          disabled={loading}
          className="text-xs text-accent hover:text-primary"
        >
          {loading ? "Checking…" : "Try again"}
        </button>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary"
        >
          <ArrowLeft size={12} /> Choose another method
        </button>
      </div>
    );
  }
  return (
    <EntryShell
      title={meta.label}
      onBack={() => setSelected(null)}
      onSubmit={() => verifyCode(selected)}
      loading={loading}
      disabled={!code}
      error={error}
      code={code}
      setCode={setCode}
      maxLength={6}
      autoFocus
      email={selected === "email" ? email : undefined}
    />
  );
}

/**
 * @param {{
 *   title?: string,
 *   onBack?: () => void,
 *   onSubmit?: () => void,
 *   loading?: boolean,
 *   disabled?: boolean,
 *   error?: string,
 *   code?: string,
 *   setCode?: (v: string) => void,
 *   placeholder?: string,
 *   maxLength?: number,
 *   autoFocus?: boolean,
 *   email?: string,
 * } | undefined} [props]
 */
function EntryShell({ title, onBack, onSubmit, loading, disabled, error, code, setCode, placeholder, maxLength, autoFocus, email } = {}) {
  const inputId = useId();
  const isOtp = typeof maxLength === "number";
  return (
    <form
      data-slot="auth-mfa-entry"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3 text-primary"
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary"
      >
        <ArrowLeft size={12} /> Choose another method
      </button>
      <label htmlFor={inputId} className="text-sm block">{title}</label>
      {email && (
        <p className="flex items-center gap-1.5 w-fit rounded-pill bg-primary text-secondary text-xs px-3 py-1.5 border border-accent/40">
          <Mail size={12} className="text-accent" /> Code sent to {email}
        </p>
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
      {error && <Alert variant="error" message={error} />}
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
  onBack: PropTypes.func,
  onSubmit: PropTypes.func,
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  error: PropTypes.string,
  code: PropTypes.string,
  setCode: PropTypes.func,
  placeholder: PropTypes.string,
  maxLength: PropTypes.number,
  email: PropTypes.string,
};