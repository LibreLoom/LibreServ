import { useState, useEffect, useCallback, useId, useRef } from "react";
import {
  ShieldCheck,
  Trash2,
  Loader2,
  LifeBuoy,
  Copy,
  Check,
  ArrowRight,
  Mail,
  Pencil,
} from "lucide-react";
import PropTypes from "prop-types";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import useMfaAvailability from "../../hooks/useMfaAvailability";
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Alert from "../common/Alert";
import OtpInput from "../ui/OtpInput";
import FormInput from "../common/forms/FormInput";
import CollapsibleSection from "../common/CollapsibleSection";
import { useSmoothResize } from "../../hooks/useSmoothResize";
import {
  prepareCreationOptions,
  bufToB64url,
  plainWebAuthnError,
} from "../../utils/webauthn";
import { TYPE_META, ORDER, inputClass } from "./mfa-shared";
import { copyToClipboard } from "../../utils/clipboard";

/**
 * @param {{ onMethodEnabled?: () => void, onComplete?: () => void, embedded?: boolean } | undefined} [props]
 */
export default function MfaCard({ onMethodEnabled, onComplete, embedded = false } = {}) {
  const { me, request } = useAuth();
  const { addToast } = useToast();
  const { availability } = useMfaAvailability();
  const [methods, setMethods] = useState(/** @type {Array<object>} */ ([]));
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [remainingRecovery, setRemainingRecovery] = useState(null);
  const [enrolling, setEnrolling] = useState(null); // type being enrolled
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(null); // string[] once
  const [copied, setCopied] = useState(false);
  const [generatingRecovery, setGeneratingRecovery] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [lastMethodError, setLastMethodError] = useState(null);
  const isAdmin = me?.role === "admin";

  // Methods the server can actually service right now. While availability is
  // loading (null) we show everything so the user isn't blocked; once it
  // resolves, unavailable options (e.g. email with no SMTP sender / no account
  // email, WebAuthn with no verifier, TOTP with no encryption key) are hidden.
  const availableTypes = ORDER.filter((t) => availability == null || !!availability[t]);

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
    await copyToClipboard(showRecoveryCodes.join("\n"), {
      suppressHaptic: true,
      onSuccess: () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        addToast({ type: "success", message: "Recovery codes copied." });
      },
      onError: () => addToast({ type: "error", message: "Couldn't copy — copy them manually." }),
    });
  }

  function onEnrolled() {
    setEnrolling(null);
    loadMethods();
    loadRecoveryRemaining();
    onMethodEnabled?.();
  }

  // When embedded (setup wizard), the host step provides the card chrome,
  // header, and explanatory copy — so we skip our own Card wrapper, title,
  // intro paragraph, and the admin-needs-MFA alert to avoid duplication.
  const body = (
    <div className="space-y-4">
        {!embedded && (
          <p className="text-sm text-primary/80">
            Two-factor authentication keeps your account safe by asking for a second
            check at login — not just your password. You need at least one method
            enabled{isAdmin ? " (required for admins)" : ""}.
          </p>
        )}

        {!embedded && adminNeedsMfa && (
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="iconSm"
                      surface="primary"
                      onClick={() => handleRemove(m)}
                      loading={removingId === m.id}
                      className="text-secondary/60 hover:text-error motion-safe:transition-colors"
                      aria-label={`Remove ${meta.label}`}
                      title="Remove this method"
                    >
                      {removingId === m.id ? null : <Trash2 size={16} />}
                    </Button>
                  </li>
                );
              })}
          </ul>
        ) : (
          !embedded && (
            <Alert
              variant="warning"
              message="No two-factor method enabled yet. Add one below to protect your account."
            />
          )
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
            {availableTypes.map((type) => {
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

        {/* Recovery codes — hidden in embedded (setup) mode; a dedicated step
            surfaces these for smoother UX. */}
        {!embedded && (
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
              variant="primary"
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  surface="primary"
                  onClick={copyCodes}
                  className="text-xs text-accent hover:text-secondary"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </Button>
              </div>
              <ol className="grid grid-cols-2 gap-1 text-sm font-mono">
                {showRecoveryCodes.map((c, i) => (
                  <li key={i} className="truncate">{c}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
        )}

        {onComplete && (
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              fullWidth
              onClick={onComplete}
              disabled={!hasAny}
              className="group py-3"
            >
              {hasAny ? "Continue" : "Enable a method to continue"}
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </Button>
          </div>
        )}
      </div>
    );

  if (embedded) return body;
  return <Card title="Two-Factor Authentication">{body}</Card>;
}

// --- Enrollment flow per method type (shared by MfaCard + setup wizard) ---
export function EnrollFlow({ type, onCancel, onEnrolled, onSessionExpired = undefined }) {
  const { me, request, refreshAuth } = useAuth();
  const { addToast } = useToast();
  const [step, setStep] = useState("setup"); // setup | verify | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState(/** @type {{secret?:string, otpauth_uri?:string, qr_image?:string}|null} */ (null));
  const [webauthnName, setWebauthnName] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const [newEmail, setNewEmail] = useState(me?.email || "");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState(null);
  const codeInputId = useId();
  const copyLabelRef = useRef(null);
  useSmoothResize(copyLabelRef);

  // Change the account email from the code-entry step, then re-send the code
  // so it lands in the NEW inbox (the old code went to the old address).
  async function handleChangeEmail(e) {
    e.preventDefault();
    if (!newEmail || emailSaving) return;
    setEmailSaving(true);
    setEmailError(null);
    try {
      await request("/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail }),
      });
      addToast({ type: "success", message: "Email updated" });
      setChangeEmailOpen(false);
      await refreshAuth?.(); // pill re-renders with the new address
      sendEmailCode(newEmail); // fresh code to the new address (newEmail ≠ stale me)
    } catch (err) {
      if (err.name === "AuthError") {
        onSessionExpired?.();
        setEmailError("Your session expired. Please log in again.");
        return;
      }
      const status = err.cause?.status;
      if (status === 409) setEmailError("That email is already in use by another account.");
      else if (status === 400) setEmailError(err.message || "Please enter a valid email.");
      else setEmailError(err.message || "Couldn't update your email. Try again.");
    } finally {
      setEmailSaving(false);
    }
  }

  // Send a fresh email-OTP code. Used both on mount (auto-send the first
  // code when the verify form appears) and from the "Send new code" button
  // so the user can re-request without leaving the step.
  const sendEmailCode = useCallback(async (toastEmail = "") => {
    setBusy(true);
    setError(null);
    try {
      const res = await request("/auth/mfa/email/setup", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Couldn't send the email code.");
      }
      // toastEmail overrides the closure's me?.email: right after a profile
      // update the component hasn't re-rendered yet, so me would be stale.
      addToast({ type: "success", message: `Code sent to ${toastEmail || me?.email || "your email"}.` });
      setStep("verify");
    } catch (err) {
      if (err.name === "AuthError") {
        onSessionExpired?.();
        setError("Your session expired. Please log in again.");
        return;
      }
      setError(err.message || "Couldn't send the email code.");
    } finally {
      setBusy(false);
    }
  }, [request, addToast, onSessionExpired, me?.email]);


  // Start TOTP/email enrollment automatically. WebAuthn waits for the name form.
  //
  // Aborts a stale in-flight setup request on re-invocation. React StrictMode
  // (dev) runs effects twice on mount, and `request`/`addToast` can change
  // identity between renders; without the AbortController both invocations
  // fire POST /auth/mfa/totp/setup and race on the pending-TOTP row, producing a
  // flaky 500 ("We couldn't set up your authenticator app"). Aborting the first
  // request before the second starts keeps a single setup call in flight.
  //
  // For email MFA, sendEmailCode must NOT be a dependency — if it is, any
  // identity change in request/addToast re-fires the effect and spams
  // POST /auth/mfa/email/setup in a loop (burning the email quota). Instead we
  // use a ref to track whether the first send already happened.
  const emailSentRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function begin() {
      if (type === "passkey" || type === "security_key") return;
      if (type === "email") {
        // Only auto-send once — the ref survives re-renders.
        if (!cancelled && !emailSentRef.current) {
          emailSentRef.current = true;
          sendEmailCode();
        }
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await request("/auth/mfa/totp/setup", { method: "POST", signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't start setup.");
        if (cancelled) return;
        setTotp(data);
        setStep("verify");
      } catch (err) {
        if (controller.signal.aborted) return; // stale request, ignore
        if (err.name === "AuthError") {
          onSessionExpired?.();
          if (!cancelled) setError("Your session expired. Please log in again.");
          return;
        }
        if (!cancelled) setError(err.message || "Setup failed. Try again.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    begin();
    return () => {
      cancelled = true;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

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
      if (err.name === "AuthError") {
        onSessionExpired?.();
        setError("Your session expired. Please log in again.");
        return;
      }
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
      if (err.name === "AuthError") {
        onSessionExpired?.();
        setError("Your session expired. Please log in again.");
        return;
      }
      setError(plainWebAuthnError(err, label));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!totp?.secret) return;
    await copyToClipboard(totp.secret, {
      suppressHaptic: true,
      onSuccess: () => {
        setSecretCopied(true);
        setTimeout(() => setSecretCopied(false), 2000);
        addToast({ type: "success", message: "Manual key copied." });
      },
      onError: () => addToast({ type: "error", message: "Couldn't copy — copy it manually." }),
    });
  }

  const isWebAuthn = type === "passkey" || type === "security_key";
  const label = TYPE_META[type].label;

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300" data-slot="mfa-card">
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
                <Button type="submit" variant="primary" fullWidth className="group py-3">
                  Register {label}
                  <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
                </Button>
              </form>
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
            <CollapsibleSection title="Can't scan? Click to show the one-time password code" size="xs" className="text-primary/70">
              <div className="flex items-center gap-2">
                {/* color-scan: ignore-next-line manual key needs a high-contrast surface for legibility + selection */}
                <code className="flex-1 block p-2 bg-primary rounded-pill break-all text-secondary text-xs">
                  {totp.secret}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  surface="secondary"
                  onClick={copySecret}
                  className="shrink-0 text-xs text-accent hover:text-primary"
                  aria-label="Copy manual key"
                >
                  <Copy size={12} />{" "}
                  <span ref={copyLabelRef} className="inline-block whitespace-nowrap">
                    {secretCopied ? "Copied" : "Copy"}
                  </span>
                </Button>
              </div>
            </CollapsibleSection>
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
          {type === "email" && me?.email && (
            <>
              {/* Layered pill: the dark email chip sits on a slightly wider
                  accent chip whose Change segment opens the email modal.
                  Compact sizing matches the v1 pill (text-xs, py-1.5). */}
              <div className="inline-flex items-center rounded-pill bg-accent text-primary text-xs border border-accent/40">
                <span className="flex items-center gap-1.5 bg-primary text-secondary rounded-pill py-1.5 pl-3 pr-2.5">
                  <Mail size={12} className="text-accent shrink-0" /> Code sent to {me.email}
                </span>
                <button
                  type="button"
                  onClick={() => setChangeEmailOpen(true)}
                  disabled={busy}
                  className="flex items-center gap-1 text-xs py-1.5 pl-2.5 pr-3 rounded-r-pill text-primary hover:underline underline-offset-2 motion-safe:transition-colors disabled:opacity-50"
                  aria-label={`Change email address (currently ${me.email})`}
                >
                  <Pencil size={11} /> Change
                </button>
              </div>
              {changeEmailOpen && (
                <ModalCard title="Change your email" onClose={() => setChangeEmailOpen(false)}>
                  <form onSubmit={handleChangeEmail} className="space-y-4">
                    <p className="text-sm text-primary/70">
                      Your sign-in codes are sent to this address. Update it and we'll
                      send a new code to the new address.
                    </p>
                    <FormInput
                      label="Email"
                      name="mfa-new-email"
                      type="email"
                      icon="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      surface="secondary"
                      required
                    />
                    {emailError && <Alert variant="error" message={emailError} />}
                    <div className="flex gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        surface="secondary"
                        fullWidth
                        onClick={() => setChangeEmailOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="accent"
                        surface="secondary"
                        fullWidth
                        loading={emailSaving}
                        disabled={!newEmail}
                      >
                        Save &amp; send new code
                      </Button>
                    </div>
                  </form>
                </ModalCard>
              )}
            </>
          )}
          <label htmlFor={codeInputId} className="sr-only">
            {type === "email" ? "Code from your email" : "6-digit code from your app"}
          </label>
          <OtpInput
            id={codeInputId}
            value={code}
            onChange={setCode}
            maxLength={6}
            disabled={busy}
            autoFocus
          />
          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={busy}
            disabled={!code}
            className="group py-3"
          >
            {busy ? (
              <>Verifying&hellip;</>
            ) : (
              <>
                Verify &amp; enable
                <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
          {type === "email" && (
            <Button
              type="button"
              variant="outline"
              surface="secondary"
              fullWidth
              loading={busy}
              onClick={sendEmailCode}
              className="py-2 text-sm"
            >
              <Mail className="w-4 h-4" /> Send a new code
            </Button>
          )}
        </form>
      )}

      {/* Persistent escape hatch: always available so the user can pick a
          different method if this one isn't working (e.g. setup errored before
          the verify form appeared, or the browser prompt was denied). */}
      <Button
        type="button"
        variant="outline"
        surface="secondary"
        fullWidth
        onClick={onCancel}
        className="py-3"
      >
        Back
      </Button>

      {error && <Alert variant="error" message={error} rounded="large-element" />}
    </div>
  );
}

MfaCard.propTypes = {
  onMethodEnabled: PropTypes.func,
  onComplete: PropTypes.func,
  embedded: PropTypes.bool,
};
EnrollFlow.propTypes = {
  type: PropTypes.oneOf(["totp", "email", "passkey", "security_key"]).isRequired,
  onCancel: PropTypes.func.isRequired,
  onEnrolled: PropTypes.func.isRequired,
  onSessionExpired: PropTypes.func,
};

// ─── Setup-wizard-only 3-phase MFA flow: choose → backup codes → setup ───────
// The setup wizard sequences MFA enrollment into distinct steps so the user
// isn't confronted with the method picker and the enrollment form at once.
//   1. Choose — pick a method (authenticator app / email / passkey / key)
//   2. Backup codes — generate + show recovery codes (the fallback first)
//   3. Setup — enroll + verify the chosen method; on success, onComplete fires
//      (which finalizes setup and redirects to the dashboard).
// MfaCard itself stays a single-screen component for My Account / MfaBlocker.
export function MfaSetupWizard({ onComplete, smtpConfigured = true, onSessionExpired }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const {
    availability,
    loading: loadingAvail,
    error: availError,
    authError: availAuthError,
    refresh: refreshAvailability,
  } = useMfaAvailability();
  const [sessionExpired, setSessionExpired] = useState(false);
  // Methods the server can actually service right now. Wait for the
  // availability check to finish before showing the picker so the setup wizard
  // doesn't offer methods that aren't configured (e.g. email when SMTP hasn't
  // been set up). A failed check shows a retry button instead of defaulting to
  // all methods, which would re-introduce the same problem.
  //
  // In the setup flow, email also requires the user to have completed the SMTP
  // step; if they skipped it we keep email hidden even if the backend config
  // already contains SMTP values, so we don't offer a delivery method the user
  // hasn't actually set up.
  const availableTypes = availability == null
    ? []
    : ORDER.filter((t) => {
        if (t === "email") {
          return smtpConfigured && !!availability.email;
        }
        return !!availability[t];
      });
  const [phase, setPhase] = useState("choose"); // choose | backup | setup
  const [selectedType, setSelectedType] = useState(null);
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [codes, setCodes] = useState(/** @type {string[] | null} */ (null));
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Generate backup codes when entering the backup phase. AbortController
  // guards the same StrictMode double-fire race as EnrollFlow.
  useEffect(() => {
    if (phase !== "backup") return;
    if (codes) return; // already generated this visit
    const controller = new AbortController();
    let cancelled = false;
    async function gen() {
      setGenerating(true);
      setGenError(null);
      try {
        const res = await request("/auth/mfa/recovery-codes", {
          method: "POST",
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't generate backup codes.");
        if (cancelled) return;
        setCodes(Array.isArray(data.codes) ? data.codes : []);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err.name === "AuthError") {
          setSessionExpired(true);
          return;
        }
        setGenError(err.message || "Couldn't generate backup codes. Try again.");
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }
    gen();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [phase, codes, request]);

  async function copyCodes() {
    if (!codes) return;
    await copyToClipboard(codes.join("\n"), {
      suppressHaptic: true,
      onSuccess: () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        addToast({ type: "success", message: "Backup codes copied." });
      },
      onError: () => addToast({ type: "error", message: "Couldn't copy — copy them manually." }),
    });
  }

  function chooseMethod(type) {
    setSelectedType(type);
    setPhase("setup");
  }

  // Session expired during setup MFA. A plain "Try again" would softlock the
  // user because the underlying request needs a fresh login; ask the parent
  // SetupPage to swap in the login gate by delegating to the callback prop.
  if (sessionExpired || availAuthError) {
    return (
      <div key="phase-expired" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <Alert
          variant="error"
          message={availError || "Your session expired. Please log in again to continue setup."}
          rounded="large-element"
        />
        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={() => onSessionExpired?.()}
          className="py-3"
        >
          Log in again
        </Button>
      </div>
    );
  }

  // Phase 1 — Choose a method
  // Each phase root is keyed so React remounts it on phase change, replaying
  // the enter animation (a patched-in-place div would not animate).
  if (phase === "choose") {
    return (
      <div key="phase-choose" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary/60 mb-3">
            Step 1 — Choose a method
          </p>
          {loadingAvail && (
            <div className="flex items-center gap-2 text-sm text-accent mb-3">
              <Loader2 size={16} className="animate-spin" /> Checking what's available on this device…
            </div>
          )}
          {!loadingAvail && availability == null && (
            <div className="space-y-3">
              <Alert
                variant="error"
                message={availError || "Couldn't check which sign-in methods are available."}
                rounded="large-element"
              />
              <Button
                type="button"
                variant="outline"
                surface="secondary"
                fullWidth
                onClick={refreshAvailability}
                className="py-3"
              >
                Try again
              </Button>
            </div>
          )}
          {!loadingAvail && availability != null && availableTypes.length === 0 && (
            <p className="text-sm text-primary/60">
              No two-factor methods are available on this device yet. Ask your administrator to enable one, then come back here.
            </p>
          )}
          {availability != null && availableTypes.length > 0 && (
            <div className="space-y-2">
              {availableTypes.map((type) => {
                const meta = TYPE_META[type];
                const Icon = meta.icon;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => chooseMethod(type)}
                    className="w-full flex items-center gap-4 p-4 rounded-large-element border border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25 motion-safe:transition-all motion-safe:duration-200"
                    title={`Add ${meta.label}`}
                  >
                    <Icon size={22} className="text-accent flex-shrink-0" />
                    <div className="flex-1 text-left">
                      <div className="font-mono text-sm text-primary">{meta.label}</div>
                      <div className="text-xs text-primary/40">{meta.desc}</div>
                    </div>
                    <ArrowRight size={16} className="text-primary/40" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Phase 3 — Backup codes (comes last now)
  if (phase === "backup") {
    return (
      <div key="phase-backup" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary/60 mb-3">
            Step 3 — Save your backup codes
          </p>
          <p className="text-sm text-primary/70 mb-4">
            These one-time codes let you sign in if you lose access to your phone or
            key. Store them somewhere safe — they're shown only once.
          </p>
        </div>

        {generating && (
          <p className="text-xs text-accent flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Generating your codes…
          </p>
        )}

        {genError && <Alert variant="error" message={genError} rounded="large-element" />}

        {codes && codes.length > 0 && (
          <>
            {/* color-scan: ignore-next-line recovery codes need a high-contrast surface for legibility */}
            <div className="p-4 rounded-large-element bg-primary text-secondary border-2 border-accent/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">Save these now — they won't be shown again</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  surface="primary"
                  onClick={copyCodes}
                  className="text-xs text-accent hover:text-secondary"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </Button>
              </div>
              <ol className="grid grid-cols-2 gap-1 text-sm font-mono">
                {codes.map((c, i) => (
                  <li key={i} className="truncate">{c}</li>
                ))}
              </ol>
            </div>
            <Button
              type="button"
              variant="primary"
              fullWidth
              onClick={() => {
                setBackupAcknowledged(true);
                onComplete?.();
              }}
              className="group py-3"
            >
              I've saved my codes
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </Button>
          </>
        )}

        <Button
          type="button"
          variant="outline"
          surface="secondary"
          fullWidth
          onClick={() => setPhase("choose")}
          className="py-3"
        >
          Back
        </Button>
      </div>
    );
  }

  // Phase 3 — Setup (enroll + verify the chosen method)
  return (
    <div key="phase-setup" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary/60 mb-3">
          Step 2 — Set up {selectedType ? TYPE_META[selectedType].label.toLowerCase() : "your method"}
        </p>
      </div>
      <EnrollFlow
        type={selectedType}
        onCancel={() => setPhase("choose")}
        onEnrolled={() => setPhase(backupAcknowledged ? "choose" : "backup")}
        onSessionExpired={() => setSessionExpired(true)}
      />
    </div>
  );
}
MfaSetupWizard.propTypes = {
  onComplete: PropTypes.func.isRequired,
  smtpConfigured: PropTypes.bool,
  onSessionExpired: PropTypes.func,
};
MfaSetupWizard.defaultProps = {
  smtpConfigured: true,
  onSessionExpired: undefined,
};
