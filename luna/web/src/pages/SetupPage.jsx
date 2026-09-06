import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback, useRef, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, Check, ChevronLeft, Eye, EyeOff, Lock, X } from "lucide-react";
import PropTypes from "prop-types";
import { getJson, postJson, ApiError } from "../lib/api";
import { isPublicLunaHost } from "../lib/publicHost";
import {
  PASSWORD_POLICY_HINT,
  passwordChecks,
} from "../lib/passwordPolicy";
import { useAuth } from "../context/AuthContext";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight";
import useSetupProgress from "../hooks/useSetupProgress";
import useConnectActive from "../hooks/useConnectActive";
import { StepTransitionContext } from "../components/setup/StepTransitionContext";
import { StepTransitionProvider } from "../components/setup/StepTransition";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import useLabelErrorState from "../hooks/useLabelErrorState";
import PreflightStep from "../components/setup/PreflightStep.jsx";
import DiscoveryPaths from "../components/setup/DiscoveryPaths.jsx";
import TextLink from "../components/ui/TextLink";

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP = {
  WELCOME:    "welcome",
  PREFLIGHT:  "preflight",
  NETWORK:    "network", // legacy saved progress only — no user-facing step (ethernet-only)
  ACCOUNT:    "account",
  NAME:       "name",
  DONE:       "done",
};

// Shared input style for the inverted (bg-secondary) setup card: a transparent
// field with a primary-toned border; text is primary (inverted to match the card).
// Same constant as LibreServ's SetupPage so the two wizards read identically.
const WIZARD_INPUT_CLASS =
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

// ─── Full-screen shell (bg-primary = page background) ────────────────────────
function SetupShell({ children }) {
  return (
    <div data-slot="setup-page" className="min-h-screen flex flex-col items-center justify-center bg-primary px-4 py-12">
      {children}
    </div>
  );
}
SetupShell.propTypes = { children: PropTypes.node.isRequired };

// One-shot slide-in wrapper. Chrome can replay CSS animations on :focus / style
// recalculation while animation-name is still set, so we drop the animate-in /
// slide-in-from-*-pop classes after the entrance finishes. Remount via `key`
// (step or substep) to play again on the next transition.
const ONE_SHOT_SLIDE_MS = 300;

function OneShotSlide({ children, className = "", direction = "right", enabled = true }) {
  const [done, setDone] = useState(false);
  const animating = enabled && !done;

  // Timeout fallback matches ModalCard: animationend can be skipped (reduced
  // motion, jsdom) and must not leave animation-name live permanently.
  useEffect(() => {
    if (!animating) return undefined;
    const id = window.setTimeout(() => setDone(true), ONE_SHOT_SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [animating]);

  return (
    <div
      data-slot="one-shot-slide"
      className={cn(
        className,
        animating && "animate-in duration-300",
        animating && (direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop"),
      )}
      // backwards (not both): drop the transform after the slide so focused
      // inputs inside don't jump on a leftover compositing layer.
      style={animating ? { animationFillMode: "backwards" } : undefined}
      onAnimationEnd={(event) => {
        // Ignore bubbled animationend from children (fade-ins, etc.).
        if (event.target !== event.currentTarget) return;
        setDone(true);
      }}
    >
      {children}
    </div>
  );
}
OneShotSlide.propTypes = {
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
  direction: PropTypes.oneOf(["left", "right"]),
  enabled:   PropTypes.bool,
};

// ─── Card surface (bg-secondary = inverted, high contrast) ───────────────────
// All step content lives on this card. Text inside uses text-primary (inverted).
// Wraps content in an animated-height container so the card resizes smoothly
// when a step's content height changes (appearing forms, errors, the address
// list, etc.) instead of snapping.
//
// The card itself does NOT fly in on mount — it stays in place and smoothly
// resizes (useAnimatedHeight). Step-to-step transitions slide the INNER content
// in from the right (advancing) or left (going back), keyed so it remounts and
// the slide replays within the card bounds (overflow-hidden clips the offset).
// Direction/key come from StepTransitionContext, provided by SetupPage.
function SetupCard({ children, className = "", header = null }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const { key: tKey, direction } = useContext(StepTransitionContext);
  return (
    <div
      ref={outerRef}
      className="w-full max-w-md bg-secondary text-primary rounded-large-element shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div ref={innerRef} className="px-10 py-10">
        {header}
        <OneShotSlide key={tKey} className={className} direction={direction}>
          {children}
        </OneShotSlide>
      </div>
    </div>
  );
}
SetupCard.propTypes = {
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
  header:    PropTypes.node,
};

// ─── Step progress dots (on the card, so use primary colors) ─────────────────
// The shared indicator across both products: a plain row of dots — active is
// a wider pill (smoothly stretched via transition-all, no entrance cascade,
// no breathe) — plus LibreServ's "N / M" step counter on the right.
// Shown on every step, including Welcome.
const VISIBLE_STEPS = [
  { id: STEP.WELCOME,    label: "Welcome" },
  { id: STEP.PREFLIGHT,  label: "System check" },
  { id: STEP.ACCOUNT,    label: "Account" },
  { id: STEP.NAME,       label: "Name" },
  { id: STEP.DONE,       label: "Done" },
];

function StepDots({ current }) {
  const idx = VISIBLE_STEPS.findIndex((s) => s.id === current);
  if (idx < 0) return null;
  return (
    <div className="flex items-center gap-2 mb-8">
      {VISIBLE_STEPS.map((s, i) => (
        <div
          key={s.id}
          className={cn(
            "rounded-full motion-safe:transition-all motion-safe:duration-300",
            i === idx
              ? "w-5 h-2 bg-primary"
              : i < idx
                ? "w-2 h-2 bg-primary/40"
                : "w-2 h-2 bg-primary/15"
          )}
          title={s.label}
          aria-label={s.label}
        />
      ))}
      <span className="ml-auto text-[11px] font-mono tracking-wider text-primary/30 animate-in fade-in duration-300">
        {idx + 1} / {VISIBLE_STEPS.length}
      </span>
    </div>
  );
}
StepDots.propTypes = { current: PropTypes.string.isRequired };

// ─── Logo mark (inline SVG — theme-aware, renders on the inverted setup card) ─
// The accent (#767676) border is constant; the white/black face and dot invert
// with bg-secondary so the mark stays readable in both themes.
function LogoMark({ size = 64 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 240"
      fill="none"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <rect x="0" y="0" width="240" height="240" rx="32" fill="var(--color-accent)" />
      <rect x="2" y="2" width="236" height="236" rx="30" fill="var(--color-primary)" />
      <circle cx="200" cy="200" r="24" fill="var(--color-secondary)" stroke="var(--color-accent)" strokeWidth="2" />
    </svg>
  );
}
LogoMark.propTypes = { size: PropTypes.number };

// ─── STEP: Welcome ────────────────────────────────────────────────────────────
// Content-only: SetupPage renders the persistent shell (SetupShell + SetupCard
// with the dots header) around the current step, so the card and the dot row
// survive step changes and the active dot's width smoothly transitions.
function WelcomeStep({ onBegin }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-10">
        <LogoMark size={120} />
      </div>

      <h1 className="font-mono text-5xl font-normal text-primary tracking-tight mb-4">
        Welcome.
      </h1>

      <p className="text-primary/68 text-xl leading-[1.65] mb-12 max-w-[22rem]">
        Let&rsquo;s get Luna set up for you.
      </p>

      <Button
        variant="primary"
        onClick={onBegin}
        className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
      >
        Begin Setup
        <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
      </Button>
    </div>
  );
}
WelcomeStep.propTypes = {
  onBegin: PropTypes.func.isRequired,
};



// ─── Password strength (same policy as LibreServ + lunad) ─────────────────────
// Acceptable = 12+ chars, a letter, and a digit. Symbols strengthen the bar but
// are NOT required — gating on them would reject passwords the backend accepts.
function strengthInfo(pw) {
  if (!pw) return null;
  return passwordChecks(pw);
}

const STRENGTH_LABEL = ["", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLOR = ["", "bg-error", "bg-warning", "bg-warning", "bg-success"];
const STRENGTH_TEXT  = ["", "text-error", "text-warning", "text-warning", "text-success"];

function PasswordStrengthBar({ score }) {
  return (
    <div className="flex gap-1 mt-2.5">
      {[1, 2, 3, 4].map((lvl) => (
        <div
          key={lvl}
          className={cn("h-1 flex-1 rounded-full motion-safe:transition-all motion-safe:duration-300", lvl <= score ? STRENGTH_COLOR[score] : "bg-primary/15")}
        />
      ))}
    </div>
  );
}
PasswordStrengthBar.propTypes = { score: PropTypes.number.isRequired };

/** A single password requirement chip: green check when met, muted X when missing. */
function ReqChip({ ok, label }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono motion-safe:transition-colors motion-safe:duration-200", ok ? "text-success" : "text-primary/50")}>
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {label}
    </span>
  );
}
ReqChip.propTypes = { ok: PropTypes.bool.isRequired, label: PropTypes.string.isRequired };

/** @param {{ id: any, label: any, hint?: any, children: any, error?: any, shake?: any, loading?: boolean }} _ */
function FormField({ id, label, hint, children, error, shake, loading = false }) {
  const { labelError, containerRef } = useLabelErrorState(error, shake, { loading });
  return (
    <div ref={containerRef}>
      <label
        htmlFor={id}
        className={cn(
          "block text-primary font-sans text-sm text-left translate-x-5 mb-1 motion-safe:transition-colors duration-300",
          labelError && "text-error",
        )}
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-primary mt-1.5 translate-x-5">{hint}</p>}
    </div>
  );
}
FormField.propTypes = {
  id:       PropTypes.string.isRequired,
  label:    PropTypes.string.isRequired,
  hint:     PropTypes.string,
  children: PropTypes.node.isRequired,
  error:    PropTypes.any,
  shake:    PropTypes.any,
  loading:  PropTypes.bool,
};

// ─── STEP: Account ────────────────────────────────────────────────────────────
// SetupCard already slides the whole account step in. Playing the same
// slide-in-from-*-pop again on the first field stacked two scales on the
// name input (and autoFocus hit mid-animation), so it jumped when selected.
// Wait for OneShotSlide's entrance (ONE_SHOT_SLIDE_MS) before focusing.

function AccountStep({ hasAdmin, onContinue, connectActive }) {
  const { user, register, login } = useAuth();
  const needsSetupCode = isPublicLunaHost() && connectActive;
  const [form, setForm] = useState({
    display_name:     "",
    username:         "",
    password:         "",
    confirm_password: "",
    setup_secret:     "",
  });
  const [showPw, setShowPw]         = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const [authSubStep, setAuthSubStep] = useState(0);
  const [authSubDir, setAuthSubDir]   = useState("right");
  // Only animate field swaps after the user moves between substeps — not on
  // the initial mount (parent SetupCard already owns that entrance).
  const authSubAnimatedRef = useRef(false);
  const fieldInputRef = useRef(null);

  const pw       = form.password;
  const confirm  = form.confirm_password;
  const strength = strengthInfo(pw);
  const meetsPolicy = !!(strength?.ok);
  const usernameOk  = form.username.trim().length >= 3;
  const confirmOk   = confirm === pw && pw !== "";
  const setupSecretOk = !needsSetupCode || form.setup_secret.trim().length > 0;

  const setField = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    if (fieldError) setFieldError(null);
  };

  const authFields = [
    {
      id: "display_name",
      question: "What's your name?",
      hint: "Shown on this Luna when you sign in. You can skip this if you like.",
      name: "display_name",
      type: "text",
      placeholder: "e.g. Alex",
      autoComplete: "name",
      valid: true,
    },
    {
      id: "username",
      question: "Pick a username",
      hint: "How you sign in — letters, numbers, dots, or dashes.",
      name: "username",
      type: "text",
      placeholder: "alex",
      autoComplete: "username",
      valid: usernameOk,
    },
    {
      id: "password",
      question: "Choose a password",
      hint: 'Not "a1!", please.',
      name: "password",
      type: "password",
      placeholder: PASSWORD_POLICY_HINT,
      autoComplete: "new-password",
      valid: meetsPolicy,
      showStrength: true,
    },
    {
      id: "confirm_password",
      question: "Confirm your password",
      hint: confirmOk && pw ? "Passwords match." : "Re-enter the password you just chose.",
      name: "confirm_password",
      type: "password",
      placeholder: "Re-enter your password",
      autoComplete: "new-password",
      valid: confirmOk,
    },
  ];
  if (needsSetupCode) {
    authFields.push({
      id: "setup_secret",
      question: "Your device token",
      hint: "Paste the device token from connect.luna.libreloom.org after you named this Luna. It confirms you finished setup there, so nobody else on the internet can create this first login.",
      name: "setup_secret",
      type: "text",
      placeholder: "Paste the device token from Luna Connect",
      autoComplete: "off",
      valid: setupSecretOk,
    });
  }

  const currentAuthField = authFields[authSubStep] || authFields[0];
  const isLastAuthSubStep = authSubStep === authFields.length - 1;
  const animateAuthSub = authSubAnimatedRef.current;

  const goSubNext = () => {
    authSubAnimatedRef.current = true;
    setAuthSubDir("right");
    setAuthSubStep((s) => Math.min(s + 1, authFields.length - 1));
  };
  const goSubPrev = () => {
    authSubAnimatedRef.current = true;
    setAuthSubDir("left");
    setAuthSubStep((s) => Math.max(s - 1, 0));
  };

  // Focus after the parent step slide finishes on first paint; on later
  // substeps focus immediately after the keyed field mounts.
  useEffect(() => {
    if (hasAdmin) return undefined;
    const delay = animateAuthSub ? 0 : ONE_SHOT_SLIDE_MS;
    const id = window.setTimeout(() => {
      fieldInputRef.current?.focus?.();
    }, delay);
    return () => window.clearTimeout(id);
    // animateAuthSub is derived from a ref set synchronously before substep updates
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus when the visible field changes
  }, [authSubStep, hasAdmin]);

  const handleCreateAccount = async () => {
    if (submitting) return;
    setSubmitting(true);
    setFieldError(null);
    try {
      const displayName = form.display_name.trim() || form.username.trim();
      await register(form.username.trim(), displayName, pw, needsSetupCode ? form.setup_secret.trim() : undefined);
      await login(form.username.trim(), pw);
      onContinue();
    } catch (err) {
      setFieldError(err.message);
      setSubmitting(false);
    }
  };

  const handleSubSubmit = async (e) => {
    e.preventDefault();
    if (!currentAuthField.valid || submitting) return;
    if (isLastAuthSubStep) {
      await handleCreateAccount();
    } else {
      goSubNext();
    }
  };

  // Luna already has an account — the wizard can't create another one.
  if (hasAdmin) {
    if (user) {
      return (
        <div className="flex flex-col items-center text-center">
          <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
            <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
            You&rsquo;re signed in
          </h2>
          <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            Signed in as <span className="font-mono text-primary">{user.username}</span>. This account manages Luna.
          </p>
          <div className="mt-8 animate-in fade-in duration-300 delay-300">
            <Button
              variant="primary"
              onClick={onContinue}
              className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
            >
              Continue
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
          <Lock className="w-7 h-7 text-primary" strokeWidth={1.5} />
        </div>
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
          Sign in to continue
        </h2>
        <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
          This Luna already has an account. Sign in with it to finish setup.
        </p>
        <div className="mt-8 animate-in fade-in duration-300 delay-300">
          <TextLink
            to="/login"
            surface="secondary"
            state={{ from: "/setup" }}
            className="font-mono text-sm underline underline-offset-4"
          >
            Sign in
          </TextLink>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
          Create your account
        </h2>
        {authSubStep === 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-primary text-sm leading-relaxed font-sans">
              You&apos;re creating the initial admin account. This account can access every file on Luna.
            </p>
            <p className="text-primary text-sm leading-relaxed font-sans">
              Later, you&apos;ll be able to add users & restrict their access to only certain drives and folders.
            </p>
          </div>
        )}
      </div>

      {/* Substep progress */}
      <div className="w-full mb-8">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-mono text-primary">
            {authSubStep + 1} of {authFields.length}
          </span>
        </div>
        <div className="flex gap-1.5">
          {authFields.map((f, i) => (
            <div key={f.id} className="flex-1 h-1 rounded-full bg-primary/15 overflow-hidden">
              <div
                className="h-full bg-primary motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.05,0.7,0.1,1)]"
                style={{ width: i <= authSubStep ? "100%" : "0%" }}
              />
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubSubmit} className="text-left">
        <ShakeTarget shake={fieldError}>
          <OneShotSlide
            key={`register-${authSubStep}`}
            enabled={animateAuthSub}
            direction={authSubDir}
          >
            <label
              htmlFor={currentAuthField.id}
              className="block font-mono text-xl text-primary mb-5 leading-snug"
            >
              {currentAuthField.question}
            </label>

            {(currentAuthField.type === "password") ? (
              <div className="relative">
                <input
                  ref={fieldInputRef}
                  id={currentAuthField.id}
                  name={currentAuthField.name}
                  type={showPw ? "text" : "password"}
                  autoComplete={currentAuthField.autoComplete}
                  placeholder={currentAuthField.placeholder}
                  value={form[currentAuthField.name]}
                  onChange={(e) => setField(currentAuthField.name, e.target.value)}
                  disabled={submitting}
                  className={cn(WIZARD_INPUT_CLASS, "pr-12")}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-primary hover:text-primary motion-safe:transition-colors motion-safe:duration-150"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            ) : (
              <input
                ref={fieldInputRef}
                id={currentAuthField.id}
                name={currentAuthField.name}
                type={currentAuthField.type}
                autoComplete={currentAuthField.autoComplete}
                placeholder={currentAuthField.placeholder}
                value={form[currentAuthField.name]}
                onChange={(e) => setField(currentAuthField.name, e.target.value)}
                disabled={submitting}
                spellCheck={currentAuthField.name === "setup_secret" ? false : undefined}
                className={WIZARD_INPUT_CLASS}
                aria-invalid={currentAuthField.name === "setup_secret" && Boolean(fieldError)}
              />
            )}

            {currentAuthField.hint && (
              <p className="mt-2.5 text-xs text-primary leading-relaxed">{currentAuthField.hint}</p>
            )}

            {currentAuthField.showStrength && strength && (
              <div className="mt-3">
                <PasswordStrengthBar score={strength.score} />
                <div className="flex items-center justify-between mt-1.5">
                  <p className={cn("text-xs font-mono", STRENGTH_TEXT[strength.score])}>
                    {STRENGTH_LABEL[strength.score]}
                  </p>
                  <p className={cn("text-xs font-mono", meetsPolicy ? "text-success" : "text-primary")}>
                    {meetsPolicy ? "✓ Acceptable" : "Not strong enough yet"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                  <ReqChip ok={strength.hasLength}  label="12+ chars" />
                  <ReqChip ok={strength.hasLetter}  label="letters" />
                  <ReqChip ok={strength.hasDigit}   label="numbers" />
                  <ReqChip ok={strength.hasSpecial} label="symbols" />
                </div>
              </div>
            )}

            {currentAuthField.name === "confirm_password" && confirm && !confirmOk && (
              <p className="text-xs text-error mt-2.5">
                Passwords don&rsquo;t match
              </p>
            )}
          </OneShotSlide>
        </ShakeTarget>

        {fieldError && (
          <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 mt-6 animate-in fade-in slide-in-from-bottom-1 duration-200">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
            <p className="text-sm text-primary">{fieldError}</p>
          </div>
        )}

        <div className="flex items-center gap-3 mt-8">
          {authSubStep > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={goSubPrev}
              disabled={submitting}
              className="shrink-0 px-4 py-4"
              aria-label="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={submitting && isLastAuthSubStep}
            disabled={!currentAuthField.valid || submitting}
            className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
          >
            {isLastAuthSubStep ? (
              submitting ? "Creating account…" : "Create account"
            ) : (
              <>
                Continue
                <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
        </div>
      </form>
    </>
  );
}
AccountStep.propTypes = {
  hasAdmin: PropTypes.bool.isRequired,
  onContinue: PropTypes.func.isRequired,
  connectActive: PropTypes.bool.isRequired,
};

// ─── STEP: Name ───────────────────────────────────────────────────────────────
function NameStep({ initialName, onFinish }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onFinish(trimmed);
    } catch (err) {
      setError(err?.message || "Luna couldn't save your name. Try again.");
      setSaving(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
          Name your Luna
        </h2>
        <p className="text-primary/50 text-sm mt-2">
          This is the name you&rsquo;ll see when you open Luna. If you ever have two, each gets its own name.
        </p>
      </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <ShakeTarget shake={error}>
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
              <FormField id="luna_name" label="Name" hint="1-40 characters">
                <input
                  id="luna_name"
                  type="text"
                  maxLength={40}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                  disabled={saving}
                  required
                  className={WIZARD_INPUT_CLASS}
                />
              </FormField>
            </div>
          </ShakeTarget>

          {/* Inline error */}
          {error && (
            <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in slide-in-from-bottom-1 duration-200">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary/80">{error}</p>
            </div>
          )}

          {/* Submit */}
          <div className="pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={saving}
              disabled={!name.trim() || saving}
              className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
            >
              {saving ? (
                "Finishing…"
              ) : (
                <>
                  Finish setup
                  <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
                </>
              )}
            </Button>
          </div>
        </form>
    </>
  );
}
NameStep.propTypes = {
  initialName: PropTypes.string,
  onFinish: PropTypes.func.isRequired,
};

// ─── STEP: Done ───────────────────────────────────────────────────────────────
function DoneStep({ name, onGoDrives }) {
  const label = name || "Luna";
  return (
    <div className="flex flex-col items-center text-center">
      {/* Check circle */}
      <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
        <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
      </div>

        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
          {label} is ready.
        </h2>
        <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
          Now plug in a USB drive. Luna will notice and won&rsquo;t touch a thing until you say so.
        </p>

        {/* Discovery paths — where to find Luna after setup */}
        <DiscoveryPaths name={label} />

        <div className="mt-8 animate-in fade-in duration-300 delay-400">
          <Button
            variant="primary"
            onClick={onGoDrives}
            className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
          >
            Go to drives
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
    </div>
  );
}
DoneStep.propTypes = {
  name: PropTypes.string,
  onGoDrives: PropTypes.func.isRequired,
};

// ─── Root: SetupPage ──────────────────────────────────────────────────────────

// Linear order of the wizard's main steps, used to derive the slide direction
// (forward → slide from right, back → slide from left) on step change.
const STEP_ORDER = [
  STEP.WELCOME,
  STEP.PREFLIGHT,
  STEP.ACCOUNT,
  STEP.NAME,
  STEP.DONE,
];

export default function SetupPage() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  // null until saved progress is loaded — avoids flashing Welcome over a resume.
  const [step, setStep] = useState(null);
  const [animationDirection, setAnimationDirection] = useState("right");
  const prevStepRef = useRef(null);
  const [hasAdmin, setHasAdmin] = useState(false);
  const [deviceName, setDeviceName] = useState("Luna");
  const { saveProgress, flushProgress } = useSetupProgress();
  const progressRef = useRef(/** @type {{ step?: string, stepData?: Record<string, unknown> }} */ ({}));
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const connectActive = useConnectActive();

  // During setup, ask lunad to peel a code from the installer USB magazine when needed.
  useEffect(() => {
    if (!hydrated) return;
    postJson("/api/v1/setup/fetch-mag", {}).catch(() => {});
  }, [hydrated]);

  // Whether an account already exists (decides if the account step creates or
  // signs in). Re-checked whenever the signed-in user changes.
  useEffect(() => {
    let alive = true;
    getJson("/api/v1/auth/status")
      .then((data) => { if (alive) setHasAdmin(Boolean(data?.has_admin)); })
      .catch(() => { /* offline — the account step will surface the error */ });
    return () => { alive = false; };
  }, [user]);

  // Restore wizard position from the device so a refresh mid-setup continues
  // where the user left off (same behavior as LibreServ).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const setup = await getJson("/api/v1/setup");
        if (!alive) return;
        if (setup?.name) setDeviceName(setup.name);

        if (setup?.setup_completed) {
          navigate("/drives", { replace: true });
          return;
        }

        const savedStep = setup?.current_step;
        const savedData = setup?.step_data && typeof setup.step_data === "object"
          ? setup.step_data
          : {};
        progressRef.current = {
          step: savedStep || STEP.WELCOME,
          stepData: savedData,
        };

        let next = STEP.WELCOME;
        if (savedStep && savedStep !== STEP.WELCOME) {
          // Luna is ethernet-only: if you can open setup, the cable path is already
          // satisfied — skip the legacy network step from older saved progress.
          next = savedStep === STEP.NETWORK ? STEP.ACCOUNT : savedStep;
          if (savedStep === STEP.WELCOME && savedData.preflight_passed) {
            next = STEP.ACCOUNT;
          }
          if (!STEP_ORDER.includes(next)) {
            next = STEP.WELCOME;
          }
        }
        // "done" is only shown after a successful finish in this session.
        // A stale/partial record should resume at naming.
        if (next === STEP.DONE) next = STEP.NAME;
        // Account already exists but session is gone → land on sign-in gate.
        if ((next === STEP.NAME || next === STEP.DONE) && !user) {
          const status = await getJson("/api/v1/auth/status").catch(() => null);
          if (!alive) return;
          if (status?.has_admin) next = STEP.ACCOUNT;
        }
        // Skip account form if that step already finished.
        if (next === STEP.ACCOUNT && savedData.account_completed) {
          next = STEP.NAME;
        }
        setStep(next);
      } catch {
        // After the first account exists, setup reads are signed-in only. If an
        // admin exists but this browser isn't signed in, land on the account
        // step so they can sign in and finish — not Welcome.
        const status = await getJson("/api/v1/auth/status").catch(() => null);
        if (!alive) return;
        setStep(status?.has_admin ? STEP.ACCOUNT : STEP.WELCOME);
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resume once on mount
  }, [navigate]);

  // Derive the slide direction from the linear step order so the transition
  // matches travel direction: advancing slides the new step in from the right,
  // going back slides it in from the left. Initial mount has no slide.
  useEffect(() => {
    if (step == null || prevStepRef.current == null) {
      prevStepRef.current = step;
      return;
    }
    if (step === prevStepRef.current) return;
    const prevIdx = STEP_ORDER.indexOf(prevStepRef.current);
    const nextIdx = STEP_ORDER.indexOf(step);
    if (prevIdx >= 0 && nextIdx >= 0) {
      setAnimationDirection(nextIdx > prevIdx ? "right" : "left");
    }
    prevStepRef.current = step;
  }, [step]);

  useEffect(() => {
    const handler = (e) => {
      if (savingRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const advanceStep = useCallback(async (nextStep, stepData) => {
    const data = stepData || progressRef.current.stepData || {};
    progressRef.current = { step: nextStep, stepData: data };
    setSaveError(null);
    savingRef.current = true;
    try {
      await saveProgress(nextStep, data);
    } catch {
      try {
        await saveProgress(nextStep, data);
      } catch {
        setSaveError("Luna couldn't save your setup progress. Check your connection and try again.");
        savingRef.current = false;
        return;
      }
    } finally {
      savingRef.current = false;
    }
    setStep(nextStep);
  }, [saveProgress]);

  const handleBegin = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), network_connected: true };
    advanceStep(STEP.PREFLIGHT, data);
  }, [advanceStep]);
  const handlePreflightPass = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), preflight_passed: true };
    advanceStep(STEP.ACCOUNT, data);
  }, [advanceStep]);
  const handleAccountContinue = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), account_completed: true };
    advanceStep(STEP.NAME, data);
  }, [advanceStep]);

  const handleFinish = useCallback(async (name) => {
    // Flush any in-flight progress save, then mark setup complete.
    await flushProgress();
    // Throws on failure so NameStep keeps its input and stays on the step.
    const saved = await postJson("/api/v1/setup", {
      name,
      setup_completed: true,
      current_step: STEP.DONE,
    });
    setDeviceName(saved?.name || name);
    // Refresh the auth context so RequireAuth sees setup_completed === true
    // and lets the post-setup navigation through.
    await refresh();
    setStep(STEP.DONE);
  }, [flushProgress, refresh]);

  if (!hydrated || step == null) {
    return (
      <SetupShell>
        <div className="w-full max-w-md bg-secondary text-primary rounded-large-element px-10 py-10 shadow-[0_32px_80px_rgba(0,0,0,0.12)]">
          <p className="font-mono text-sm text-primary text-center">Loading setup…</p>
        </div>
      </SetupShell>
    );
  }

  let renderedStep;
  if (step === STEP.WELCOME) {
    renderedStep = <WelcomeStep onBegin={handleBegin} />;
  } else if (step === STEP.PREFLIGHT) {
    renderedStep = <PreflightStep onPass={handlePreflightPass} />;
  } else if (step === STEP.ACCOUNT) {
    renderedStep = (
      <AccountStep
        hasAdmin={hasAdmin}
        onContinue={handleAccountContinue}
        connectActive={connectActive}
      />
    );
  } else if (step === STEP.NAME) {
    renderedStep = <NameStep initialName={deviceName} onFinish={handleFinish} />;
  } else if (step === STEP.DONE) {
    renderedStep = <DoneStep name={deviceName} onGoDrives={() => navigate("/drives")} />;
  }

  // One persistent shell for the whole wizard. Because the SetupShell +
  // SetupCard (and thus the dot row in the header) survive step changes, the
  // active dot's width smoothly transitions (transition-all) and the card
  // resizes smoothly (useAnimatedHeight) as you move between steps — only the
  // inner content remounts and slides. Each step is content-only for this.
  return (
    <StepTransitionProvider stepKey={step} direction={animationDirection}>
      <SetupShell>
        <SetupCard header={<StepDots current={step} />}>
          {saveError && (
            <div className="mb-6 flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary">{saveError}</p>
            </div>
          )}
          {renderedStep}
        </SetupCard>
      </SetupShell>
    </StepTransitionProvider>
  );
}
