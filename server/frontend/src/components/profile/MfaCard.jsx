import { useState, useEffect, useCallback, useId } from "react";
import {
  KeyRound,
  Mail,
  Fingerprint,
  Usb,
  ShieldCheck,
  Trash2,
  Loader2,
  LifeBuoy,
  Copy,
  ArrowRight,
} from "lucide-react";
import PropTypes from "prop-types";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import Card from "../cards/Card";
import Button from "../ui/Button";
import Alert from "../common/Alert";
import {
  prepareCreationOptions,
  bufToB64url,
} from "../../utils/webauthn";

const TYPE_META = {
  totp: { icon: KeyRound, label: "Authenticator app", desc: "An app like Authy, 1Password, or Google Authenticator" },
  email: { icon: Mail, label: "Email code", desc: "A one-time code sent to your email" },
  passkey: { icon: Fingerprint, label: "Passkey", desc: "Unlock with your device (Face ID, Touch ID, or Windows Hello)" },
  security_key: { icon: Usb, label: "Security key", desc: "A physical key you plug in or tap, like a YubiKey" },
};

const ORDER = ["totp", "email", "passkey", "security_key"];

// Shared styles for inputs/buttons inside the inverted (bg-secondary) Card.
const inputClass =
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

const primaryButtonClass =
  "group w-full inline-flex items-center justify-center gap-2 rounded-pill bg-primary text-secondary py-3 font-mono text-sm tracking-wide motion-safe:transition-all motion-safe:duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";

const secondaryButtonClass =
  "w-full rounded-pill border border-primary/20 bg-transparent text-primary px-6 py-3 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/8";

/**
 * @param {{ onMethodEnabled?: () => void, onComplete?: () => void } | undefined} [props]
 */
export default function MfaCard({ onMethodEnabled, onComplete } = {}) {
  const { me, request } = useAuth();
  const { addToast } = useToast();
  const [methods, setMethods] = useState(/** @type {Array<object>} */ ([]));
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [remainingRecovery, setRemainingRecovery] = useState(null);
  const [enrolling, setEnrolling] = useState(null); // type being enrolled
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(null); // string[] once
  const [generatingRecovery, setGeneratingRecovery] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [lastMethodError, setLastMethodError] = useState(null);
  const isAdmin = me?.role === "admin";

  const loadMethods = useCallback(async () => {
    setLoadingMethods(true);
    setLastMethodError(null);
    try {
      const res = await request("/auth/mfa/methods");
      const data = await res.json();
      setMethods(Array.isArray(data.methods) ? data.methods : []);
    } catch {
      addToast({ type: "error", message: "Couldn't load your two-factor methods." });
    } finally {
      setLoadingMethods(false);
    }
  }, [request, addToast]);

  const loadRecoveryRemaining = useCallback(async () => {
    try {
      const res = await request("/auth/mfa/recovery-codes");
      const data = await res.json();
      setRemainingRecovery(typeof data.remaining === "number" ? data.remaining : null);
    } catch {
      // Non-fatal — recovery panel just hides the count.
    }
  }, [request]);

  useEffect(() => {
    loadMethods();
    loadRecoveryRemaining();
  }, [loadMethods, loadRecoveryRemaining]);

  const enabled = methods.filter((m) => m.enabled);
  const hasAny = enabled.length > 0;

  // Admins must have MFA; surface a clear prompt if they don't yet.
  const adminNeedsMfa = isAdmin && !hasAny;

  async function handleRemove(method) {
    setLastMethodError(null);
    setRemovingId(method.id);
    try {
      await request(`/auth/mfa/methods/${method.id}`, { method: "DELETE" });
      addToast({ type: "success", message: "Two-factor method removed." });
      await loadMethods();
    } catch (err) {
      const status = err.cause?.status;
      if (status === 409) {
        // Backend rejects removing the last enabled method — no softlock.
        setLastMethodError(
          err.message ||
            "You can't remove your only two-factor method. You need at least one enabled to stay logged in safely.",
        );
      } else if (status === 404) {
        setLastMethodError("That method is already gone — refreshing.");
        await loadMethods();
      } else {
        setLastMethodError(err.message || "Couldn't remove that method. Try again.");
      }
    } finally {
      setRemovingId(null);
    }
  }

  async function handleGenerateRecovery() {
    setGeneratingRecovery(true);
    try {
      const res = await request("/auth/mfa/recovery-codes", { method: "POST" });
      const data = await res.json();
      setShowRecoveryCodes(Array.isArray(data.codes) ? data.codes : []);
      setRemainingRecovery(Array.isArray(data.codes) ? data.codes.length : null);
      addToast({
        type: "success",
        message: "New recovery codes generated. Save them now — they're shown only once.",
      });
    } catch (err) {
      addToast({ type: "error", message: err.message || "Couldn't generate recovery codes." });
    } finally {
      setGeneratingRecovery(false);
    }
  }

  async function copyCodes() {
    if (!showRecoveryCodes) return;
    try {
      await navigator.clipboard.writeText(showRecoveryCodes.join("\n"));
      addToast({ type: "success", message: "Recovery codes copied." });
    } catch {
      addToast({ type: "error", message: "Couldn't copy — copy them manually." });
    }
  }

  function onEnrolled() {
    setEnrolling(null);
    loadMethods();
    loadRecoveryRemaining();
    onMethodEnabled?.();
  }

  return (
    <Card title="Two-Factor Authentication">
      <div className="space-y-4">
        <p className="text-sm text-primary/80">
          Two-factor authentication keeps your account safe by asking for a second
          check at login — not just your password. You need at least one method
          enabled{isAdmin ? " (required for admins)" : ""}.
        </p>

        {adminNeedsMfa && (
          <Alert
            variant="error"
            message="As an admin, you must enable at least one two-factor method. Your account is at higher risk without it."
          />
        )}

        {/* Enabled methods */}
        {loadingMethods ? (
          <p className="text-xs text-accent flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading your methods…
          </p>
        ) : hasAny ? (
          <ul className="space-y-2">
            {enabled
              .slice()
              .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
              .map((m) => {
                const meta = TYPE_META[m.type] || { icon: ShieldCheck, label: m.label || m.type };
                const Icon = meta.icon;
                return (
                  <li
                    key={m.id}
                    className="flex items-center justify-between px-4 py-3 rounded-large-element bg-primary text-secondary border border-accent/40"
                  >
                    <span className="flex items-center gap-3 text-sm">
                      <Icon size={16} className="text-accent shrink-0" />
                      {meta.label}
                      {(() => {
                        const lastUsed = m.last_used_at ? new Date(m.last_used_at) : null;
                        return lastUsed && !isNaN(lastUsed.getTime()) ? (
                          <span className="text-xs text-secondary/50">
                            · used {lastUsed.toLocaleDateString()}
                          </span>
                        ) : null;
                      })()}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemove(m)}
                      disabled={removingId === m.id}
                      className="text-secondary/60 hover:text-error motion-safe:transition-colors disabled:opacity-50"
                      aria-label={`Remove ${meta.label}`}
                      title="Remove this method"
                    >
                      {removingId === m.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </li>
                );
              })}
          </ul>
        ) : (
          <Alert
            variant="warning"
            message="No two-factor method enabled yet. Add one below to protect your account."
          />
        )}

        {lastMethodError && <Alert variant="error" message={lastMethodError} />}

        {/* Add-a-method picker */}
        {enrolling ? (
          <EnrollFlow
            type={enrolling}
            onCancel={() => setEnrolling(null)}
            onEnrolled={onEnrolled}
          />
        ) : (
          <div className="space-y-2">
            {ORDER.map((type) => {
              const meta = TYPE_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setEnrolling(type)}
                  className="w-full flex items-center gap-4 p-4 rounded-large-element border border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25 motion-safe:transition-all motion-safe:duration-200"
                  title={`Add ${meta.label}`}
                >
                  <Icon size={22} className="text-accent flex-shrink-0" />
                  <div className="flex-1 text-left">
                    <div className="font-mono text-sm text-primary">{meta.label}</div>
                    <div className="text-xs text-primary/40">{meta.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Recovery codes */}
        <div className="pt-4 border-t border-accent/30">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-primary/80">
              <LifeBuoy size={14} className="text-accent" />
              Recovery codes
              {typeof remainingRecovery === "number" && (
                <span className="text-xs text-primary/50">
                  · {remainingRecovery} left
                </span>
              )}
            </span>
            <Button
              type="button"
              variant="accent"
              size="sm"
              loading={generatingRecovery}
              onClick={handleGenerateRecovery}
            >
              {remainingRecovery ? "Regenerate" : "Generate"}
            </Button>
          </div>
          <p className="text-xs text-primary/60 mt-1">
            Use a recovery code to sign in if you lose access to your phone or key.
            Store them somewhere safe — they're shown only once.
          </p>
          {showRecoveryCodes && (
            <div className="mt-3 p-4 rounded-large-element bg-primary text-secondary border-2 border-accent/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">Save these now — they won't be shown again</span>
                <button
                  type="button"
                  onClick={copyCodes}
                  className="text-xs text-accent hover:text-secondary flex items-center gap-1"
                >
                  <Copy size={12} /> Copy all
                </button>
              </div>
              <ol className="grid grid-cols-2 gap-1 text-sm font-mono">
                {showRecoveryCodes.map((c, i) => (
                  <li key={i} className="truncate">{c}</li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {onComplete && (
          <div className="pt-2">
            <button
              type="button"
              onClick={onComplete}
              disabled={!hasAny}
              className={primaryButtonClass}
            >
              {hasAny ? "Continue" : "Enable a method to continue"}
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

// --- Enrollment flow per method type ---
function EnrollFlow({ type, onCancel, onEnrolled }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [step, setStep] = useState("setup"); // setup | verify | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState(/** @type {{secret?:string, otpauth_uri?:string, qr_image?:string}|null} */ (null));
  const [webauthnName, setWebauthnName] = useState("");
  const codeInputId = useId();

  // Start TOTP/email enrollment automatically. WebAuthn waits for the name form.
  useEffect(() => {
    let cancelled = false;
    async function begin() {
      if (type === "passkey" || type === "security_key") return;
      setBusy(true);
      setError(null);
      try {
        if (type === "totp") {
          const res = await request("/auth/mfa/totp/setup", { method: "POST" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Couldn't start setup.");
          if (cancelled) return;
          setTotp(data);
          setStep("verify");
        } else if (type === "email") {
          const res = await request("/auth/mfa/email/setup", { method: "POST" });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || "Couldn't send the email code.");
          }
          if (cancelled) return;
          addToast({ type: "success", message: "Code sent to your email." });
          setStep("verify");
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Setup failed. Try again.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    begin();
    return () => {
      cancelled = true;
    };
  }, [type, request, addToast]);

  async function verifyCode() {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const path = type === "totp" ? "/auth/mfa/totp/verify" : "/auth/mfa/email/verify";
      const res = await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "That code didn't match. Try again.");
      }
      addToast({ type: "success", message: `${TYPE_META[type].label} added.` });
      onEnrolled();
    } catch (err) {
      setError(err.message || "Verification failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runWebAuthn(label) {
    const beginRes = await request("/auth/mfa/webauthn/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, type }),
    });
    const begin = await beginRes.json();
    if (!beginRes.ok) throw new Error(begin.error || "Couldn't start registration.");
    const creationOptions = prepareCreationOptions(begin.options?.publicKey ?? begin.options);
    const cred = await navigator.credentials.create({ publicKey: creationOptions });
    const assertion = /** @type {PublicKeyCredential} */ (cred);
    const response = /** @type {AuthenticatorAttestationResponse} */ (assertion?.response);
    const credential = {
      id: assertion?.id,
      rawId: bufToB64url(assertion?.rawId),
      response: {
        attestationObject: bufToB64url(response?.attestationObject),
        clientDataJSON: bufToB64url(response?.clientDataJSON),
        transports:
          typeof response?.getTransports === "function" ? response.getTransports() : undefined,
      },
      type: assertion?.type,
      authenticatorAttachment: assertion?.authenticatorAttachment || (type === "passkey" ? "platform" : "cross-platform"),
    };
    const finishRes = await request("/auth/mfa/webauthn/register/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, label, type }),
    });
    if (!finishRes.ok) {
      const d = await finishRes.json().catch(() => ({}));
      throw new Error(d.error || "Couldn't finish registration. Try again.");
    }
    addToast({ type: "success", message: `${TYPE_META[type].label} added.` });
    onEnrolled();
  }

  async function startWebAuthn() {
    setBusy(true);
    setError(null);
    try {
      const label = webauthnName.trim() || TYPE_META[type].label;
      await runWebAuthn(label);
    } catch (err) {
      setError(err.message || "Setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const isWebAuthn = type === "passkey" || type === "security_key";
  const label = TYPE_META[type].label;

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Status line */}
      <div className="flex items-center gap-2 text-sm text-primary/80">
        {busy ? (
          <Loader2 size={14} className="animate-spin text-accent" />
        ) : (
          <ShieldCheck size={14} className="text-accent" />
        )}
        <span>
          {isWebAuthn
            ? `Give this ${label.toLowerCase()} a name, then follow your browser's prompt.`
            : step === "verify"
              ? `Enter the code to finish adding ${label.toLowerCase()}.`
              : `Setting up ${label.toLowerCase()}…`}
        </span>
      </div>

      {/* WebAuthn name form */}
      {isWebAuthn && (
        <>
          {busy ? (
            <div className="flex items-center gap-2 text-sm text-primary/80">
              <Loader2 size={14} className="animate-spin text-accent" /> Follow your browser's prompt…
            </div>
          ) : (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  startWebAuthn();
                }}
                className="space-y-3"
              >
                <div>
                  <label
                    htmlFor="mfa_webauthn_name"
                    className="text-primary/80 font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
                  >
                    Name
                  </label>
                  <input
                    id="mfa_webauthn_name"
                    type="text"
                    value={webauthnName}
                    onChange={(e) => setWebauthnName(e.target.value)}
                    placeholder={label}
                    className={inputClass}
                    autoFocus
                  />
                  <p className="text-xs text-primary/60 mt-1 px-5">
                    For example "My phone" or "Office key".
                  </p>
                </div>
                <button type="submit" className={primaryButtonClass}>
                  Register {label}
                  <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
                </button>
              </form>
              <button type="button" onClick={onCancel} className={secondaryButtonClass}>
                Cancel
              </button>
            </>
          )}
        </>
      )}

      {/* TOTP QR + code entry */}
      {type === "totp" && step === "verify" && totp && (
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
          <p className="text-xs text-primary/70">
            Scan this with your authenticator app (e.g. Authy, Google Authenticator, 1Password).
          </p>
          {/* color-scan: ignore-next-line QR codes require a white/light background to be scannable by phone cameras */}
          <div className="flex justify-center bg-white p-3 rounded-large-element w-fit mx-auto">
            {totp.qr_image ? (
              <img src={totp.qr_image} alt="QR code for your authenticator app" className="w-48 h-48" />
            ) : (
              <>
                {/* color-scan: ignore-next-line dark text on the white QR container for a legible fallback */}
                <span className="text-xs text-black/70">Ask your admin to enable server QR rendering.</span>
              </>
            )}
          </div>
          {totp.secret && (
            <details className="text-xs text-primary/70">
              <summary className="cursor-pointer hover:text-primary">Can't scan? Show the manual key</summary>
              <code className="block mt-2 p-2 bg-primary rounded-pill break-all text-secondary">{totp.secret}</code>
            </details>
          )}
        </div>
      )}

      {/* Code entry for TOTP + email. */}
      {(type === "totp" || type === "email") && step === "verify" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            verifyCode();
          }}
          className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75"
        >
          <label htmlFor={codeInputId} className="sr-only">
            {type === "email" ? "Code from your email" : "6-digit code from your app"}
          </label>
          <input
            id={codeInputId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={type === "email" ? "Code from your email" : "6-digit code from your app"}
            className={inputClass}
            autoFocus
          />
          <button type="submit" disabled={busy || !code} className={primaryButtonClass}>
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Verifying&hellip;
              </>
            ) : (
              <>
                Verify &amp; enable
                <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </button>
          <button type="button" onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
        </form>
      )}

      {error && <Alert variant="error" message={error} />}
    </div>
  );
}

MfaCard.propTypes = {
  onMethodEnabled: PropTypes.func,
  onComplete: PropTypes.func,
};
EnrollFlow.propTypes = {
  type: PropTypes.oneOf(["totp", "email", "passkey", "security_key"]).isRequired,
  onCancel: PropTypes.func.isRequired,
  onEnrolled: PropTypes.func.isRequired,
};