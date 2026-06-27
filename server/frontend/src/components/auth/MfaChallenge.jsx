import { useState } from "react";
import {
  KeyRound,
  Mail,
  Fingerprint,
  Usb,
  ShieldCheck,
  ArrowLeft,
  Loader2,
  LifeBuoy,
} from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button";
import Alert from "../common/Alert";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import { bufToB64url, prepareRequestOptions } from "../../utils/webauthn";

const METHOD_META = {
  totp: { icon: KeyRound, label: "Authenticator app" },
  email: { icon: Mail, label: "Email code" },
  passkey: { icon: Fingerprint, label: "Passkey" },
  security_key: { icon: Usb, label: "Security key" },
};

export default function MfaChallenge({ mfaToken, methods, onSuccess, onBack }) {
  const { mfaChallenge, mfaVerify, mfaRecover } = useAuth();
  const { addToast } = useToast();
  const [selected, setSelected] = useState(null); // method type, or "recovery"
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function verifyCode(type) {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      await mfaVerify(mfaToken, type, { code });
      addToast({ type: "success", message: "Signed in." });
      onSuccess();
    } catch {
      setError("That code didn't work. Try again.");
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
    } catch {
      setError("We couldn't verify that device. Try another method.");
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
    } catch {
      setError("That recovery code didn't work.");
    } finally {
      setLoading(false);
    }
  }

  // --- Selection screen ---
  if (!selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-secondary">
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
                    if (isWebAuthn) verifyWebAuthn(m.type);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-large-element border-2 border-secondary/30 hover:border-accent hover:ring-2 hover:ring-accent motion-safe:transition-all text-secondary"
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
            className="flex items-center gap-1 text-xs text-secondary/70 hover:text-secondary"
          >
            <ArrowLeft size={12} /> Back to password
          </button>
        )}
        {error && <Alert variant="error" message={error} />}
        {loading && (
          <p className="text-xs text-accent flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Checking your device…
          </p>
        )}
      </div>
    );
  }

  // --- Recovery code entry ---
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
      <div className="space-y-3 text-secondary">
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
          className="flex items-center gap-1 text-xs text-secondary/70 hover:text-secondary"
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
      placeholder={selected === "email" ? "Enter the code from your email" : "Enter the 6-digit code"}
      autoFocus
    />
  );
}

function EntryShell({ title, onBack, onSubmit, loading, disabled, error, code, setCode, placeholder, autoFocus }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3 text-secondary"
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-secondary/70 hover:text-secondary"
      >
        <ArrowLeft size={12} /> Choose another method
      </button>
      <label className="text-sm block">{title}</label>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={placeholder}
        className="w-full px-4 py-2 border-2 border-secondary/30 rounded-pill bg-secondary text-primary focus:ring-2 focus:ring-accent focus:ring-offset-2"
        autoFocus={autoFocus}
      />
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
  autoFocus: PropTypes.bool,
};